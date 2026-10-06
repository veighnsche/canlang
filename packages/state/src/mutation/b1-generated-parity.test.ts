/**
 * B1 generated-descriptor parity proofs (colocated): CRUD-path execution
 * (`invoke` + `generatedCrudExecute`) and scenario-path execution (the
 * seam's one-write `runMutationWrites` staging shape, with
 * `gateArchivedTargets`) agree verdict-for-verdict over the REAL
 * `t18-shop.can` artifact — no hand-built descriptors anywhere.
 *
 * Proves: literal/parent/server/nullable/array default resolution,
 * parent linkage, update omission + protected fields, receipt
 * `resolvedDefaults`, and replay-once agree across both paths.
 * Unsupported computed inits stay whole-set-rejected (pinned by the T18
 * loader suite — cited, not duplicated — plus one B1 consumer pin that
 * the rejection surfaces before any table builds).
 *
 * Boundary: scenario-path staging here mirrors the seam's pipeline call
 * (one write, admitted context, archived gate on); the REAL emitted
 * scenario handlers execute in the cloudflare seam (lane C), which C2
 * proves against this released slice. Scenario replay rides the same
 * `invoke` receipt mechanism as CRUD replay (the seam executes inside
 * `invoke`), pinned structurally here via the CRUD replay proof.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CompileArtifact } from '../../../contracts/src/artifact.js';
import type {
  ModelName,
  OperationName,
  Receipt,
  ReceiptIdentity,
  RecordId,
  StoragePort,
  StoredRow,
} from '../../../contracts/src/state.js';
import {
  IncompatibleArtifactError,
  loadArtifactDescriptors,
  type ArtifactDescriptorSlice,
  type LoadedArtifactDescriptors,
} from '../invocation/registry.js';
import { buildModelTableFromCanonical, type ModelTable } from './models.js';
import { generatedCrudExecute } from './crud.js';
import { runMutationWrites } from './pipeline.js';
import { invoke } from '../invocation/invoke.js';
import { receiptIdentityFor } from '../invocation/admission.js';
import { buildContext } from '../invocation/context.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import {
  FIXED_NOW,
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
import { T18_SHOP_ARTIFACT_JSON } from './t18-shop.artifact.js';

const APP = 'acme-app';
const TEAM = 'Shop.Team';
const MEMBER = 'Shop.Member';
const TEAM_CREATE = 'Shop.Team.create';
const TEAM_UPDATE = 'Shop.Team.update';
const MEMBER_CREATE = 'Shop.Member.create';
const EXPECTED_ISO = new Date(FIXED_NOW).toISOString();
const HEX64 = /^[0-9a-f]{64}$/;

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

interface B1World {
  store: StoragePort;
  memberships: TestMembershipStore;
  alice: SeededMember;
  loaded: LoadedArtifactDescriptors;
  table: ModelTable;
}

async function setupWorld(): Promise<B1World> {
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const loaded = loadShop();
  const table = buildModelTableFromCanonical(loaded.models, {
    refs: loaded.refs,
    serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields,
    // B5: every B1 agreement below holds under declared ownership too
    // (Member parented to Team, Team a declared root).
    containment: loaded.containment,
  });
  return { store, memberships, alice, loaded, table };
}

let b1Seq = 9000;

function nextOperationId(): string {
  b1Seq += 1;
  return uuidv7(FIXED_NOW, b1Seq);
}

function minimalTeamInputs(): Record<string, unknown> {
  return { name: 'team-one', owner: { id: 'u-boss' }, flags: ['f1'] };
}

/** CRUD path: real `invoke` with the generated CRUD executor. */
async function crudInvoke(
  world: B1World,
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

/**
 * Scenario path: the seam's one-write staging shape — a single
 * `runMutationWrites` call under an admitted-equivalent context with the
 * archived gate on. The context mirrors what `invoke` builds for the
 * scenario operation (same actor/team/clock; the operation name is the
 * scenario's own).
 */
async function scenarioStage(
  world: B1World,
  write: {
    readonly op: 'create' | 'update' | 'remove';
    readonly model: ModelName;
    readonly id: RecordId;
    readonly parent?: { readonly model: ModelName; readonly id: RecordId };
    readonly data?: Record<string, unknown>;
  },
  scenarioOp = 'Shop.RunScenario',
) {
  const context = buildContext({
    identity: makeIdentity({
      membership: world.alice.membership,
      email: world.alice.user.email,
    }),
    operation: scenarioOp as OperationName,
    operationId: nextOperationId(),
    app: APP,
    source: 'test',
    now: FIXED_NOW,
  });
  return runMutationWrites({
    table: world.table,
    writes: [write],
    context,
    store: world.store,
    gateArchivedTargets: true,
  });
}

async function crudReceipt(
  world: B1World,
  operation: string,
  operationId: string,
): Promise<Receipt> {
  const context = buildContext({
    identity: makeIdentity({
      membership: world.alice.membership,
      email: world.alice.user.email,
    }),
    operation: operation as OperationName,
    operationId,
    app: APP,
    source: 'test',
    now: FIXED_NOW,
  });
  const identity: ReceiptIdentity = receiptIdentityFor(context);
  const receipt = await world.store.readReceipt(identity);
  assert.ok(receipt !== null, `CRUD receipt for ${operation} ${operationId} committed`);
  return receipt;
}

/** Commit one staged scenario batch at the store's current revision. */
async function commitStaged(
  world: B1World,
  output: Awaited<ReturnType<typeof scenarioStage>>,
): Promise<void> {
  const revision = await world.store.readRevision();
  await world.store.commit(
    makeBatch(revision as number, {
      writes: [...output.writes],
      history: [...output.history],
      uniqueClaims: [...output.uniqueClaims],
      uniqueReleases: [...output.uniqueReleases],
    }),
  );
}

describe('B1 generated parity: create agreement', () => {
  it('Team.create data + receipt defaults agree CRUD-vs-scenario', async () => {
    const crud = await setupWorld();
    const scen = await setupWorld();
    const opId = nextOperationId();
    const created = await crudInvoke(crud, TEAM_CREATE, opId, minimalTeamInputs());
    assert.equal(created.status, 'committed');
    const crudRow = created.result as StoredRow;
    const staged = await scenarioStage(scen, {
      op: 'create',
      model: TEAM as ModelName,
      id: 'team-s1' as RecordId,
      data: minimalTeamInputs(),
    });
    const stagedWrite = staged.writes[0];
    assert.ok(stagedWrite !== undefined && stagedWrite.kind === 'insert');
    const scenRow = stagedWrite.row;
    // Engine-filled fields agree exactly (caller, literal, nullable,
    // array, and server-init order shared through the one pipeline).
    // `stock` is the exact-literal-string '0' (T15a emission; T18 pins
    // the string verbatim — L2 codecs interpret it downstream).
    for (const [field, expected] of [
      ['name', 'team-one'],
      ['stock', '0'],
      ['kind', 'home'],
      ['note', null],
      ['made', EXPECTED_ISO],
    ] as const) {
      assert.deepEqual(crudRow.data[field], expected, `CRUD ${field}`);
      assert.deepEqual(scenRow.data[field], expected, `scenario ${field}`);
    }
    assert.deepEqual(crudRow.data['owner'], { id: 'u-boss' });
    assert.deepEqual(scenRow.data['owner'], { id: 'u-boss' });
    assert.deepEqual(crudRow.data['tags'], []);
    assert.deepEqual(scenRow.data['tags'], []);
    assert.deepEqual(crudRow.data['flags'], ['f1']);
    assert.deepEqual(scenRow.data['flags'], ['f1']);
    const aliceId = crud.alice.membership.user_id;
    assert.deepEqual(crudRow.data['by'], { id: aliceId });
    assert.deepEqual(scenRow.data['by'], { id: scen.alice.membership.user_id });
    // random_secret mints per execution: same SHAPE, independent material.
    assert.match(String(crudRow.data['token']), HEX64);
    assert.match(String(scenRow.data['token']), HEX64);
    // Receipt defaults agree modulo the per-execution secret AND the
    // admission input-fill split (T18-pinned): admission normalizes
    // omitted ordinary-array INPUTS to `[]` before the pipeline runs, so
    // the CRUD receipt excludes `tags` (the pipeline filled nothing);
    // staged scenario writes carry no operation inputs, so the pipeline
    // genuinely resolves omit-to-empty and records it. Rows agree either
    // way; each receipt records what its layer resolved.
    const receipt = await crudReceipt(crud, TEAM_CREATE, opId);
    const { token: _crudToken, ...crudDefaults } = receipt.resolvedDefaults;
    const { token: _scenToken, tags: _scenTags, ...scenDefaults } = staged.resolvedDefaults;
    assert.deepEqual(scenDefaults, crudDefaults);
    assert.deepEqual(staged.resolvedDefaults['tags'], []);
    assert.ok(!Object.hasOwn(receipt.resolvedDefaults, 'tags'));
    assert.match(String(receipt.resolvedDefaults['token']), HEX64);
    assert.match(String(staged.resolvedDefaults['token']), HEX64);
  });

  it('Member.create parent linkage + parent-path defaults agree', async () => {
    const crud = await setupWorld();
    const scen = await setupWorld();
    const crudTeamOp = nextOperationId();
    const crudTeam = (await crudInvoke(crud, TEAM_CREATE, crudTeamOp, minimalTeamInputs()))
      .result as StoredRow;
    const scenTeamStaged = await scenarioStage(scen, {
      op: 'create',
      model: TEAM as ModelName,
      id: 'team-s1' as RecordId,
      data: minimalTeamInputs(),
    });
    await commitStaged(scen, scenTeamStaged);
    const crudMemberOp = nextOperationId();
    const crudMember = (
      await crudInvoke(crud, MEMBER_CREATE, crudMemberOp, {
        name: 'mem-one',
        parent: { id: crudTeam.id },
      })
    ).result as StoredRow;
    const scenMemberStaged = await scenarioStage(scen, {
      op: 'create',
      model: MEMBER as ModelName,
      id: 'mem-s1' as RecordId,
      parent: { model: TEAM as ModelName, id: 'team-s1' as RecordId },
      data: { name: 'mem-one' },
    });
    const stagedWrite = scenMemberStaged.writes[0];
    assert.ok(stagedWrite !== undefined && stagedWrite.kind === 'insert');
    const scenMember = stagedWrite.row;
    assert.deepEqual(crudMember.parent, { model: TEAM, id: crudTeam.id });
    assert.deepEqual(scenMember.parent, { model: TEAM, id: 'team-s1' });
    // Parent-path default resolves off the loaded parent on both paths.
    assert.deepEqual(crudMember.data['buddy'], { id: 'u-boss' });
    assert.deepEqual(scenMember.data['buddy'], { id: 'u-boss' });
    assert.equal(crudMember.data['nick'], null);
    assert.equal(scenMember.data['nick'], null);
    assert.equal(crudMember.data['state'], 'new');
    assert.equal(scenMember.data['state'], 'new');
    assert.equal(crudMember.data['seen'], EXPECTED_ISO);
    assert.equal(scenMember.data['seen'], EXPECTED_ISO);
    assert.ok(!Object.hasOwn(crudMember.data, 'parent'));
    assert.ok(!Object.hasOwn(scenMember.data, 'parent'));
  });
});

describe('B1 generated parity: negative + update agreement', () => {
  it('caller-supplied server-only fields reject loud on both paths (documented layer split)', async () => {
    const crud = await setupWorld();
    const scen = await setupWorld();
    const tampered = { ...minimalTeamInputs(), made: '2030-01-01T00:00:00.000Z' };
    // CRUD: the emitter excludes server-owned fields from operation
    // inputs, so admission rejects the undeclared member first.
    const crudError = await captureStateError(
      crudInvoke(crud, TEAM_CREATE, nextOperationId(), tampered),
    );
    assert.equal(crudError.code, 'validation');
    assert.equal(crudError.message, 'Invalid operation inputs.');
    assert.deepEqual(
      (crudError.fields ?? []).map((field) => field.path),
      ['/made'],
    );
    // Scenario: staged writes key by FIELD name, so `made` is a known
    // field and the pipeline's server-only rule rejects. Same code,
    // layer-honest message — never silent on either path.
    const scenError = await captureStateError(
      scenarioStage(scen, {
        op: 'create',
        model: TEAM as ModelName,
        id: 'team-s1' as RecordId,
        data: tampered,
      }),
    );
    assert.equal(scenError.code, 'validation');
    assert.equal(scenError.message, 'Field "made" is server-only and cannot be supplied.');
  });

  it('required-array omission rejects loud on both paths (documented layer split)', async () => {
    const crud = await setupWorld();
    const scen = await setupWorld();
    const { flags: _omitted, ...noFlags } = minimalTeamInputs();
    // CRUD: the emitted input is required, so admission rejects first.
    const crudError = await captureStateError(
      crudInvoke(crud, TEAM_CREATE, nextOperationId(), noFlags),
    );
    assert.equal(crudError.code, 'validation');
    assert.deepEqual(
      (crudError.fields ?? []).map((field) => field.path),
      ['/flags'],
    );
    // Scenario: staged writes carry no operation inputs, so the pipeline's
    // required-array rule rejects. Same code, layer-honest message.
    const scenError = await captureStateError(
      scenarioStage(scen, {
        op: 'create',
        model: TEAM as ModelName,
        id: 'team-s1' as RecordId,
        data: noFlags,
      }),
    );
    assert.equal(scenError.code, 'validation');
    assert.equal(scenError.message, 'Missing required field "flags".');
  });

  it('update omission + protected fields agree on both paths', async () => {
    const crud = await setupWorld();
    const scen = await setupWorld();
    const crudTeam = (
      await crudInvoke(crud, TEAM_CREATE, nextOperationId(), minimalTeamInputs())
    ).result as StoredRow;
    const scenStaged = await scenarioStage(scen, {
      op: 'create',
      model: TEAM as ModelName,
      id: 'team-s1' as RecordId,
      data: minimalTeamInputs(),
    });
    await commitStaged(scen, scenStaged);
    // Omission means unchanged on both paths; server fields are untouched.
    const crudUpdated = (
      await crudInvoke(crud, TEAM_UPDATE, nextOperationId(), {
        record: { id: crudTeam.id, version: '1' },
        name: 'team-renamed',
      })
    ).result as StoredRow;
    const scenStagedUpdate = await scenarioStage(scen, {
      op: 'update',
      model: TEAM as ModelName,
      id: 'team-s1' as RecordId,
      data: { name: 'team-renamed' },
    });
    const stagedWrite = scenStagedUpdate.writes[0];
    assert.ok(stagedWrite !== undefined && stagedWrite.kind === 'update');
    assert.equal(crudUpdated.data['name'], 'team-renamed');
    assert.equal(stagedWrite.row.data['name'], 'team-renamed');
    assert.equal(crudUpdated.version, 2);
    assert.equal(stagedWrite.row.version, 2);
    assert.equal(crudUpdated.data['made'], EXPECTED_ISO);
    assert.equal(stagedWrite.row.data['made'], EXPECTED_ISO);
    assert.equal(crudUpdated.data['stock'], '0');
    assert.equal(stagedWrite.row.data['stock'], '0');
    // Protected server-only fields reject loud on update (same
    // admission-vs-pipeline layer split as creates, pinned above).
    const crudError = await captureStateError(
      crudInvoke(crud, TEAM_UPDATE, nextOperationId(), {
        record: { id: crudTeam.id, version: '2' },
        made: '2030-01-01T00:00:00.000Z',
      }),
    );
    const scenError = await captureStateError(
      scenarioStage(scen, {
        op: 'update',
        model: TEAM as ModelName,
        id: 'team-s1' as RecordId,
        data: { made: '2030-01-01T00:00:00.000Z' },
      }),
    );
    assert.equal(crudError.code, 'validation');
    assert.equal(crudError.message, 'Invalid operation inputs.');
    assert.equal(scenError.code, 'validation');
    assert.equal(scenError.message, 'Field "made" is server-only and cannot be supplied.');
  });
});

describe('B1 generated parity: replay + computed boundary', () => {
  it('CRUD replay returns the committed row without re-evaluating server inits', async () => {
    const crud = await setupWorld();
    const opId = nextOperationId();
    const first = await crudInvoke(crud, TEAM_CREATE, opId, minimalTeamInputs());
    assert.equal(first.status, 'committed');
    const replayed = await crudInvoke(crud, TEAM_CREATE, opId, minimalTeamInputs());
    assert.equal(replayed.status, 'replayed');
    // Byte-identical result including the minted secret: replay never
    // re-evaluates (scenario replay rides this same invoke receipt path —
    // the seam executes inside `invoke` — proven with the real seam at C2).
    assert.deepEqual(replayed.result, first.result);
    assert.match(String((replayed.result as StoredRow).data['token']), HEX64);
  });

  it('computed server inits abort the consumer before any table builds', async () => {
    // Loader pin lives in the T18 suite (whole-set
    // `unsupported_server_init`); this B1 consumer pin proves the
    // rejection surfaces before any canonical table — and therefore any
    // execution — can proceed from the slice.
    const slice = shopSlice();
    assert.ok(slice.models !== undefined);
    const team = slice.models.find((model) => model.name === TEAM);
    const made = team?.fields.find((entry) => entry.name === 'made');
    assert.ok(made?.default !== undefined && made.default.kind === 'server');
    made.default = { kind: 'server', init: 'computed' };
    let tableBuilt = false;
    let error: unknown = null;
    try {
      const loaded = loadArtifactDescriptors(slice, { by: 'members' });
      buildModelTableFromCanonical(loaded.models, {
        refs: loaded.refs,
        serverInits: loaded.serverInits,
        nullableFields: loaded.nullableFields,
      });
      tableBuilt = true;
    } catch (failure) {
      error = failure;
    }
    assert.ok(error instanceof IncompatibleArtifactError);
    assert.equal(error.reason, 'unsupported_server_init');
    assert.equal(tableBuilt, false);
  });
});
