/**
 * T18 defaults + server-init proofs (colocated): the REAL `can compile`
 * artifact for `t18-shop.can` (embedded byte-identical stdout in
 * `t18-shop.artifact.ts`, source-bound by sha256) through the real
 * load → admit → invoke path on the memory store. Proves the T18
 * creation evaluation order (caller → literal → parent-path →
 * required-array rejection → known-nullable null-fill → ordinary-array
 * omit-to-empty → closed-set server init → hooks), update
 * omission/protected fields, replay-once, and the adopted R27 rule
 * (engine creation-init plus hook pending-adjustment only; the ordinary
 * path rejects server-owned fields).
 *
 * No hand-built descriptors anywhere on the acceptance path: every invoke
 * below runs descriptors the compiler emitted. loader/model validation
 * branches (unknown tokens, doubles) use small hand-mutated COPIES of the
 * real slice and are labeled as such.
 */

import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CompileArtifact } from '@canlang/contracts';
import type {
  ModelName,
  ReceiptIdentity,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import {
  IncompatibleArtifactError,
  loadArtifactDescriptors,
  type ArtifactDescriptorSlice,
  type LoadedArtifactDescriptors,
} from '../invocation/registry.js';
import {
  buildModelTable,
  buildModelTableFromCanonical,
  type InterimHook,
  type InterimModelDef,
  type ModelTable,
} from './models.js';
import { generatedCrudExecute } from './crud.js';
import { runMutationWrites } from './pipeline.js';
import { invoke } from '../invocation/invoke.js';
import { buildContext } from '../invocation/context.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import {
  FIXED_NOW,
  captureStateError,
  createMemoryIdentityStore,
  makeEnvelope,
  makeIdentity,
  seedMember,
  uuidv7,
  type SeededMember,
  type TestMembershipStore,
} from '../../test/invocation/fixtures.js';
import { T18_SHOP_ARTIFACT_JSON, T18_SHOP_SOURCE } from './t18-shop.artifact.js';

const APP = 'acme-app';
const TEAM = 'Shop.Team';
const MEMBER = 'Shop.Member';
const TEAM_CREATE = 'Shop.Team.create';
const MEMBER_CREATE = 'Shop.Member.create';
const EXPECTED_ISO = new Date(FIXED_NOW).toISOString();
const HEX64 = /^[0-9a-f]{64}$/;

/** Parse the embedded artifact; fail loud when it is not what T18 compiled. */
function shopArtifact(): CompileArtifact {
  return JSON.parse(T18_SHOP_ARTIFACT_JSON) as CompileArtifact;
}

/** The loader slice of the embedded artifact (operations/models/version). */
function shopSlice(): ArtifactDescriptorSlice {
  const artifact = shopArtifact();
  const { operations, models } = artifact;
  assert.equal(artifact.artifact_version, 1);
  assert.ok(Array.isArray(operations) && operations.length > 0);
  assert.ok(Array.isArray(models) && models.length > 0);
  return { artifact_version: artifact.artifact_version, operations, models };
}

/** Load the real descriptors once (registry + models + T18 channels). */
function loadShop(): LoadedArtifactDescriptors {
  return loadArtifactDescriptors(shopSlice(), { by: 'members' });
}

interface T18Setup {
  store: StoragePort;
  memberships: TestMembershipStore;
  alice: SeededMember;
  loaded: LoadedArtifactDescriptors;
  table: ModelTable;
}

async function setupT18(): Promise<T18Setup> {
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const loaded = loadShop();
  const table = buildModelTableFromCanonical(loaded.models, {
    refs: loaded.refs,
    serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields,
  });
  return { store, memberships, alice, loaded, table };
}

function callArgs(setup: T18Setup) {
  return {
    app: APP,
    source: 'test',
    store: setup.store,
    memberships: setup.memberships,
    clock: { nowMs: () => FIXED_NOW },
    execute: generatedCrudExecute({ table: setup.table, store: setup.store }),
    identity: makeIdentity({ membership: setup.alice.membership, email: setup.alice.user.email }),
  };
}

let t18Seq = 5000;

function nextOperationId(): string {
  t18Seq += 1;
  return uuidv7(FIXED_NOW, t18Seq);
}

/** Minimal valid Team.create inputs (everything else is engine-filled). */
function minimalTeamInputs(): Record<string, unknown> {
  return { name: 'team-one', owner: { id: 'u-boss' }, flags: ['f1'] };
}

function aliceUserId(setup: T18Setup): string {
  return setup.alice.membership.user_id;
}

function receiptIdentityFor(
  setup: T18Setup,
  operation: string,
  operationId: string,
): ReceiptIdentity {
  return {
    app: APP,
    owner: setup.alice.membership.team_id,
    principal: setup.alice.membership.user_id,
    operation: operation as ReceiptIdentity['operation'],
    operationId: operationId as ReceiptIdentity['operationId'],
  };
}

async function createTeam(
  setup: T18Setup,
  inputs: Record<string, unknown>,
  operationId: string = nextOperationId(),
): Promise<StoredRow> {
  const result = await invoke({
    ...callArgs(setup),
    registry: setup.loaded.registry,
    envelope: makeEnvelope(TEAM_CREATE, operationId, inputs),
  });
  assert.equal(result.status, 'committed');
  return result.result as StoredRow;
}

describe('T18 fixture genuineness + loader channels', () => {
  it('binds the embedded artifact to its source and carries init tokens', () => {
    const sha = createHash('sha256').update(T18_SHOP_SOURCE, 'utf8').digest('hex');
    const artifact = shopArtifact();
    assert.equal(artifact.sources[0]?.sha256, sha);
    const models = artifact.models;
    assert.ok(models !== undefined);
    const team = models.find((model) => model.name === TEAM);
    assert.ok(team !== undefined);
    const field = (name: string) => team?.fields.find((entry) => entry.name === name);
    assert.deepEqual(field('made')?.default, { kind: 'server', init: 'now' });
    assert.deepEqual(field('by')?.default, { kind: 'server', init: 'actor' });
    assert.deepEqual(field('token')?.default, { kind: 'server', init: 'random_secret' });
    assert.equal(field('note')?.nullable, true);
    const member = models.find((entry) => entry.name === MEMBER);
    assert.deepEqual(
      member?.fields.find((entry) => entry.name === 'buddy')?.default,
      { kind: 'parent', path: 'owner' },
    );
  });

  it('synthesizes the parent input on child creates only', () => {
    const artifact = shopArtifact();
    const operations = artifact.operations;
    assert.ok(operations !== undefined);
    const inputsOf = (name: string) =>
      operations.find((op) => op.name === name)?.inputs.fields ?? [];
    const parent = inputsOf(MEMBER_CREATE).find((input) => input.name === 'parent');
    assert.ok(parent !== undefined);
    assert.equal(parent.required, true);
    assert.deepEqual(parent.field, { kind: 'ref', model: TEAM, requireVersion: false });
    for (const name of [TEAM_CREATE, 'Shop.Team.update', 'Shop.Team.delete', 'Shop.Member.update']) {
      assert.ok(
        inputsOf(name).every((input) => input.name !== 'parent'),
        `no parent input on ${name}`,
      );
    }
  });

  it('rejects computed server inits whole-set (hand-mutated copy)', () => {
    const slice = shopSlice();
    assert.ok(slice.models !== undefined);
    const team = slice.models.find((model) => model.name === TEAM);
    assert.ok(team !== undefined);
    const made = team?.fields.find((entry) => entry.name === 'made');
    assert.ok(made?.default !== undefined && made.default.kind === 'server');
    made.default = { kind: 'server', init: 'computed' };
    const error = ((): IncompatibleArtifactError | null => {
      try {
        loadArtifactDescriptors(slice, { by: 'members' });
      } catch (failure) {
        assert.ok(failure instanceof IncompatibleArtifactError);
        return failure;
      }
      return null;
    })();
    assert.ok(error !== null, 'computed init rejects the set');
    assert.equal(error.reason, 'unsupported_server_init');
  });

  it('rejects unknown init tokens (hand-mutated copy)', () => {
    const slice = shopSlice();
    assert.ok(slice.models !== undefined);
    const team = slice.models.find((model) => model.name === TEAM);
    const made = team?.fields.find((entry) => entry.name === 'made');
    assert.ok(made?.default !== undefined && made.default.kind === 'server');
    made.default = { kind: 'server', init: 'bogus' as 'now' };
    const error = ((): IncompatibleArtifactError | null => {
      try {
        loadArtifactDescriptors(slice, { by: 'members' });
      } catch (failure) {
        assert.ok(failure instanceof IncompatibleArtifactError);
        return failure;
      }
      return null;
    })();
    assert.ok(error !== null, 'unknown init rejects the set');
    assert.equal(error.reason, 'malformed_descriptor');
  });

  it('tolerates bare server defaults: unspecified inits resolve nothing', async () => {
    const slice = shopSlice();
    assert.ok(slice.models !== undefined);
    for (const model of slice.models) {
      for (const field of model.fields) {
        if (field.default !== undefined && field.default.kind === 'server') {
          field.default = { kind: 'server' };
        }
      }
    }
    const loaded = loadArtifactDescriptors(slice, { by: 'members' });
    assert.equal(loaded.serverInits.get(TEAM as ModelName)?.size ?? -1, 0);
    const setup = await setupT18();
    const table = buildModelTableFromCanonical(loaded.models, {
      refs: loaded.refs,
      serverInits: loaded.serverInits,
      nullableFields: loaded.nullableFields,
    });
    const hooked = { ...setup, loaded, table };
    const row = await createTeam(hooked, minimalTeamInputs());
    assert.ok(!Object.hasOwn(row.data, 'made'));
    assert.ok(!Object.hasOwn(row.data, 'by'));
    assert.ok(!Object.hasOwn(row.data, 'token'));
  });
});

describe('T18 creation evaluation order', () => {
  it('minimal create resolves literal/parent/null/array/server fills in order', async () => {
    const setup = await setupT18();
    const operationId = nextOperationId();
    const row = await createTeam(setup, minimalTeamInputs(), operationId);
    assert.equal(row.id, operationId);
    assert.equal(row.version, 1);
    assert.deepEqual(row.data['name'], 'team-one');
    assert.deepEqual(row.data['owner'], { id: 'u-boss' });
    // Literal defaults land verbatim (wire-opaque, like caller values).
    assert.deepEqual(row.data['stock'], '0');
    assert.deepEqual(row.data['kind'], 'home');
    // Known-nullable fills null; ordinary arrays omit to empty.
    assert.ok(Object.hasOwn(row.data, 'note'));
    assert.equal(row.data['note'], null);
    assert.deepEqual(row.data['tags'], []);
    assert.deepEqual(row.data['flags'], ['f1']);
    // Closed-set server inits resolve last, before hooks.
    assert.equal(row.data['made'], EXPECTED_ISO);
    assert.equal(row.data['made'], new Date(row.created).toISOString());
    assert.deepEqual(row.data['by'], { id: aliceUserId(setup) });
    assert.equal(row.createdBy, aliceUserId(setup));
    assert.ok(typeof row.data['token'] === 'string' && HEX64.test(row.data['token'] as string));
    // The committed receipt records every engine fill (provenance).
    const receipt = await setup.store.readReceipt(
      receiptIdentityFor(setup, TEAM_CREATE, operationId),
    );
    assert.ok(receipt !== null && receipt.outcome.status === 'committed');
    assert.deepEqual(receipt.resolvedDefaults['stock'], '0');
    assert.deepEqual(receipt.resolvedDefaults['kind'], 'home');
    assert.equal(receipt.resolvedDefaults['note'], null);
    // Admission normalizes omitted ordinary-array INPUTS to `[]` before
    // the pipeline runs, so the row carries `tags: []` while the
    // pipeline-level receipt records only the fills it performed itself.
    assert.ok(!Object.hasOwn(receipt.resolvedDefaults, 'tags'));
    assert.equal(receipt.resolvedDefaults['made'], EXPECTED_ISO);
    assert.deepEqual(receipt.resolvedDefaults['by'], { id: aliceUserId(setup) });
    assert.equal(receipt.resolvedDefaults['token'], row.data['token']);
  });

  it('caller values win over every fill; nothing is filled over', async () => {
    const setup = await setupT18();
    const row = await createTeam(setup, {
      ...minimalTeamInputs(),
      stock: '5',
      kind: 'away',
      note: 'kept',
      tags: ['t1'],
    });
    assert.deepEqual(row.data['stock'], '5');
    assert.deepEqual(row.data['kind'], 'away');
    assert.deepEqual(row.data['note'], 'kept');
    assert.deepEqual(row.data['tags'], ['t1']);
  });

  it('explicit null fails required and never triggers a fill', async () => {
    const setup = await setupT18();
    const missing = await captureStateError(
      invoke({
        ...callArgs(setup),
        registry: setup.loaded.registry,
        envelope: makeEnvelope(TEAM_CREATE, nextOperationId(), {
          ...minimalTeamInputs(),
          name: null,
        }),
      }),
    );
    assert.equal(missing.code, 'validation');
    // Explicit null on nullable stores (indistinguishable from the fill,
    // but caller-authored — omission and null stay distinct inputs).
    const nulled = await createTeam(setup, { ...minimalTeamInputs(), note: null });
    assert.equal(nulled.data['note'], null);
    // T04b remainder (pinned honestly): explicit null on a non-nullable
    // defaulted field stores instead of rejecting — the T04a engine has
    // no nullability rejection vocabulary (only the T18 known-nullable
    // fill). Omission still fills the default, so the two stay distinct.
    const stored = await createTeam(setup, { ...minimalTeamInputs(), stock: null });
    assert.equal(stored.data['stock'], null);
  });

  it('required-array omission rejects; ordinary arrays omit to empty', async () => {
    const setup = await setupT18();
    const { flags: _dropped, ...withoutFlags } = minimalTeamInputs();
    const error = await captureStateError(
      invoke({
        ...callArgs(setup),
        registry: setup.loaded.registry,
        envelope: makeEnvelope(TEAM_CREATE, nextOperationId(), withoutFlags),
      }),
    );
    assert.equal(error.code, 'validation');
    assert.deepEqual(
      (error.fields ?? []).map((field) => field.path),
      ['/flags'],
    );
    assert.deepEqual(
      (error.fields ?? []).map((field) => field.code),
      ['required'],
    );
  });
});

describe('T18 parent evaluation order', () => {
  async function createMember(
    setup: T18Setup,
    inputs: Record<string, unknown>,
    operationId: string = nextOperationId(),
  ) {
    const result = await invoke({
      ...callArgs(setup),
      registry: setup.loaded.registry,
      envelope: makeEnvelope(MEMBER_CREATE, operationId, inputs),
    });
    assert.equal(result.status, 'committed');
    return result.result as StoredRow;
  }

  it('child create links the parent and resolves parent-path defaults', async () => {
    const setup = await setupT18();
    const team = await createTeam(setup, minimalTeamInputs());
    const row = await createMember(setup, { name: 'mem-one', parent: { id: team.id } });
    assert.deepEqual(row.parent, { model: TEAM, id: team.id });
    // Parent-path default resolves off the loaded parent row.
    assert.deepEqual(row.data['buddy'], { id: 'u-boss' });
    assert.equal(row.data['nick'], null);
    assert.deepEqual(row.data['state'], 'new');
    assert.equal(row.data['seen'], EXPECTED_ISO);
    // Linkage is linkage: `parent` never lands in field data.
    assert.ok(!Object.hasOwn(row.data, 'parent'));
  });

  it('caller buddy wins over the parent-path default', async () => {
    const setup = await setupT18();
    const team = await createTeam(setup, minimalTeamInputs());
    const row = await createMember(setup, {
      name: 'mem-two',
      buddy: { id: 'u-other' },
      parent: { id: team.id },
    });
    assert.deepEqual(row.data['buddy'], { id: 'u-other' });
  });

  it('parent linkage failures reject: missing, unknown, archived', async () => {
    const setup = await setupT18();
    const team = await createTeam(setup, minimalTeamInputs());
    const missing = await captureStateError(
      invoke({
        ...callArgs(setup),
        registry: setup.loaded.registry,
        envelope: makeEnvelope(MEMBER_CREATE, nextOperationId(), { name: 'orphan' }),
      }),
    );
    assert.equal(missing.code, 'validation');
    assert.deepEqual(
      (missing.fields ?? []).map((field) => field.path),
      ['/parent'],
    );
    const ghost = await captureStateError(
      createMember(setup, { name: 'ghost', parent: { id: 'team-ghost' } }),
    );
    assert.equal(ghost.code, 'not_found');
    // Archive the parent through the generated delete, then reuse it.
    const archived = await invoke({
      ...callArgs(setup),
      registry: setup.loaded.registry,
      envelope: makeEnvelope('Shop.Team.delete', nextOperationId(), {
        record: { id: team.id, version: '1' },
      }),
    });
    assert.equal(archived.status, 'committed');
    assert.equal((archived.result as StoredRow).archivedAt, FIXED_NOW);
    const stale = await captureStateError(
      createMember(setup, { name: 'late', parent: { id: team.id } }),
    );
    assert.equal(stale.code, 'validation');
    assert.match(stale.message, /rchived/);
  });
});

describe('T18 update omission + protected fields', () => {
  it('omission means unchanged: no fills, no re-evaluation on update', async () => {
    const setup = await setupT18();
    const team = await createTeam(setup, minimalTeamInputs());
    const result = await invoke({
      ...callArgs(setup),
      registry: setup.loaded.registry,
      envelope: makeEnvelope('Shop.Team.update', nextOperationId(), {
        record: { id: team.id, version: '1' },
        note: 'updated',
      }),
    });
    assert.equal(result.status, 'committed');
    const row = result.result as StoredRow;
    assert.equal(row.version, 2);
    assert.equal(row.data['note'], 'updated');
    // Everything omitted is byte-identical — defaults never re-apply and
    // server values never re-evaluate on the update path.
    assert.deepEqual(row.data['stock'], '0');
    assert.deepEqual(row.data['kind'], 'home');
    assert.deepEqual(row.data['tags'], []);
    assert.deepEqual(row.data['flags'], ['f1']);
    assert.equal(row.data['made'], EXPECTED_ISO);
    assert.deepEqual(row.data['by'], { id: aliceUserId(setup) });
    assert.equal(row.data['token'], team.data['token']);
  });

  it('empty patch commits unchanged data; explicit null stores on nullable', async () => {
    const setup = await setupT18();
    const team = await createTeam(setup, minimalTeamInputs());
    const untouched = await invoke({
      ...callArgs(setup),
      registry: setup.loaded.registry,
      envelope: makeEnvelope('Shop.Team.update', nextOperationId(), {
        record: { id: team.id, version: '1' },
      }),
    });
    assert.equal(untouched.status, 'committed');
    assert.deepEqual((untouched.result as StoredRow).data, team.data);
    const nulled = await invoke({
      ...callArgs(setup),
      registry: setup.loaded.registry,
      envelope: makeEnvelope('Shop.Team.update', nextOperationId(), {
        record: { id: team.id, version: '2' },
        note: null,
      }),
    });
    assert.equal(nulled.status, 'committed');
    assert.equal((nulled.result as StoredRow).data['note'], null);
    const required = await captureStateError(
      invoke({
        ...callArgs(setup),
        registry: setup.loaded.registry,
        envelope: makeEnvelope('Shop.Team.update', nextOperationId(), {
          record: { id: team.id, version: '3' },
          name: null,
        }),
      }),
    );
    assert.equal(required.code, 'validation');
  });

  it('ordinary path rejects server-owned fields on create and update', async () => {
    const setup = await setupT18();
    // Creates: server fields are not inputs at all (admission closed-shape).
    for (const field of ['made', 'by', 'token']) {
      const error = await captureStateError(
        invoke({
          ...callArgs(setup),
          registry: setup.loaded.registry,
          envelope: makeEnvelope(TEAM_CREATE, nextOperationId(), {
            ...minimalTeamInputs(),
            [field]: 'smuggled',
          }),
        }),
      );
      assert.equal(error.code, 'validation');
      assert.deepEqual(
        (error.fields ?? []).map((entry) => entry.code),
        ['unknown_input'],
      );
    }
    // Updates: server fields are not change inputs either (same closed
    // shape). The pipeline's server-only rejection is the second layer
    // (defense in depth for direct callers; interim-pinned in T16a).
    const team = await createTeam(setup, minimalTeamInputs());
    for (const field of ['made', 'by', 'token']) {
      const error = await captureStateError(
        invoke({
          ...callArgs(setup),
          registry: setup.loaded.registry,
          envelope: makeEnvelope('Shop.Team.update', nextOperationId(), {
            record: { id: team.id, version: '1' },
            [field]: 'smuggled',
          }),
        }),
      );
      assert.equal(error.code, 'validation');
      assert.deepEqual(
        (error.fields ?? []).map((entry) => entry.code),
        ['unknown_input'],
      );
    }
    // Second layer, same canonical table: direct pipeline callers still
    // hit the server-only rejection (bypasses admission by construction).
    const direct = await captureStateError(
      runMutationWrites({
        table: setup.table,
        writes: [
          {
            op: 'update',
            model: TEAM as ModelName,
            id: team.id,
            data: { token: 'smuggled' },
          },
        ],
        context: buildContext({
          identity: makeIdentity({
            membership: setup.alice.membership,
            email: setup.alice.user.email,
          }),
          operation: 'Shop.Team.update' as never,
          operationId: nextOperationId(),
          app: APP,
          source: 'test',
          now: FIXED_NOW,
        }),
        store: setup.store,
      }),
    );
    assert.equal(direct.code, 'validation');
    assert.match(direct.message, /server-only/);
    // Nothing persisted from the rejections (fenced rejected receipts
    // carry no writes): the row is untouched at version 1.
    const rows = await setup.store.query({ model: TEAM as ModelName, authority: 'owner' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.version, 1);
  });
});

describe('T18 replay-once', () => {
  it('identical envelope replays the committed server values', async () => {
    const setup = await setupT18();
    const operationId = nextOperationId();
    const envelope = makeEnvelope(TEAM_CREATE, operationId, minimalTeamInputs());
    const first = await invoke({ ...callArgs(setup), registry: setup.loaded.registry, envelope });
    assert.equal(first.status, 'committed');
    const committed = first.result as StoredRow;
    const second = await invoke({
      ...callArgs(setup),
      registry: setup.loaded.registry,
      envelope: makeEnvelope(TEAM_CREATE, operationId, minimalTeamInputs()),
    });
    assert.equal(second.status, 'replayed');
    // Replay returns the committed row — `made`/`token` are never
    // re-evaluated (the secret is stable per committed identity).
    assert.deepEqual(second.result, committed);
    const rows = await setup.store.query({ model: TEAM as ModelName, authority: 'owner' });
    assert.equal(rows.length, 1);
  });

  it('fresh identities mint fresh secrets', async () => {
    const setup = await setupT18();
    const one = await createTeam(setup, minimalTeamInputs());
    const two = await createTeam(setup, minimalTeamInputs());
    assert.ok(one.data['token'] !== two.data['token']);
    assert.ok(HEX64.test(two.data['token'] as string));
  });
});

describe('T18/R27 adopted rule: hooks adjust, callers never', () => {
  it('hooks observe resolved server values and may adjust them', async () => {
    const setup = await setupT18();
    const teamDef = setup.table.get(TEAM as ModelName);
    assert.ok(teamDef !== undefined);
    let observed: Record<string, unknown> | null = null;
    const hook: InterimHook = {
      name: 't18-observe',
      ops: ['create'],
      run: (candidate) => {
        observed = { ...candidate };
        return { ...candidate, token: 'hooked', note: 'via-hook' };
      },
    };
    // Engine-local hook attachment on the canonical-derived def (the T04a
    // posture: hooks stay engine-local until T04b joins them).
    const defs: InterimModelDef[] = [...setup.table.values()].map((def) =>
      (def.model as string) === TEAM ? { ...def, hooks: [hook] } : def,
    );
    const hooked = { ...setup, table: buildModelTable(defs) };
    const operationId = nextOperationId();
    const result = await invoke({
      ...callArgs(hooked),
      registry: hooked.loaded.registry,
      envelope: makeEnvelope(TEAM_CREATE, operationId, minimalTeamInputs()),
    });
    assert.equal(result.status, 'committed');
    const row = result.result as StoredRow;
    // The hook observed the fully prepared candidate (server values
    // resolved before hooks) and its adjustment persisted.
    assert.ok(observed !== null);
    assert.equal((observed as Record<string, unknown>)['made'], EXPECTED_ISO);
    assert.deepEqual((observed as Record<string, unknown>)['by'], {
      id: aliceUserId(setup),
    });
    const seen = (observed as Record<string, unknown>)['token'];
    assert.ok(typeof seen === 'string' && HEX64.test(seen));
    assert.equal(row.data['token'], 'hooked');
    assert.equal(row.data['note'], 'via-hook');
  });
});

describe('T18 model validation branches', () => {
  it('rejects unknown server inits, server+default doubles, bad nullable', () => {
    const base = {
      model: 'M' as ModelName,
      refs: [],
      uniqueKeys: [],
      deleteMode: 'archive' as const,
      hooks: [],
      invariants: [],
      locks: [],
    };
    assert.throws(
      () =>
        buildModelTable([
          { ...base, fields: { f: { required: false, serverOnly: true, server: 'bogus' as never } } },
        ]),
      /server init/,
    );
    assert.throws(
      () =>
        buildModelTable([
          {
            ...base,
            fields: { f: { required: false, serverOnly: true, server: 'now', default: 'x' } },
          },
        ]),
      /mutually exclusive/,
    );
    assert.throws(
      () =>
        buildModelTable([
          { ...base, fields: { f: { required: false, serverOnly: false, nullable: 'yes' as never } } },
        ]),
      /nullable/,
    );
  });
});
