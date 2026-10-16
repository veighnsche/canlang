/**
 * Outcome 9 family E (Lane C): authority-report runtime boundary in the State
 * invocation owner.
 *
 * An authority-shaped scenario (`read=true scope=authority`, described,
 * `by`-admitted, declared result) is CHECK-clean at the compiler and must at
 * runtime: evaluate its pure body reads in DECISION mode (bounded owner
 * authority, no read-policy recursion — DESIGN §442) and serve its typed
 * result as an explicit grant to `by` (DESIGN §522). Ordinary `read=true`
 * stays viewer-filtered and byte-identical.
 *
 * Failing-first probe plus reusable coverage including the negatives:
 * undescribed refuses, viewer-mode read of authority data refuses, and
 * ordinary reads are unaffected.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ArtifactModel,
  ArtifactModelField,
  ArtifactOperation,
  ArtifactOperationInput,
  ReadEnvelope,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from './registry.js';
import { isGeneratedOperationDef } from './registry.js';
import {
  bindAuthorityReportScope,
  invokeRead,
  invokeReadPage,
  invokeReadScenario,
} from './invoke.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import { buildPolicyTable, type PolicyTable } from '../policy/grants.js';
import {
  FIXED_NOW,
  asModel,
  captureStateError,
  createMemoryIdentityStore,
  makeIdentity,
  seedMember,
  seedRow,
  type SeededMember,
} from '../../test/invocation/fixtures.js';

const APP = 'acme-app';
const GADGET = 'Shop.Gadget';
const TOTALS = 'Shop.totals';
const INSPECT_AUTHORITY = 'Shop.inspectAuthority';
const SOURCE = { path: 'shop.can', sha256: 'a'.repeat(64), module: 'shop' };
const DESCRIPTION = 'Confidential totals granted to members.';

function modelField(name: string, field: ArtifactModelField['field'], required: boolean): ArtifactModelField {
  return { name, field, required, serverOnly: false };
}

function refInput(name: string, model: string): ArtifactOperationInput {
  return { name, field: { kind: 'ref', model, requireVersion: true }, required: true };
}

/** Authority slice: CRUD plus two described authority reports with `int` results. */
function authoritySlice(): ArtifactDescriptorSlice {
  const gadget: ArtifactModel = {
    name: GADGET,
    fields: [
      modelField('title', { kind: 'string' }, true),
      modelField('stock', { kind: 'integer' }, false),
      modelField('code', { kind: 'string' }, true),
    ],
    deleteMode: 'archive',
  };
  const crudInputs: ArtifactOperationInput[] = [
    { name: 'title', field: { kind: 'string' }, required: true },
    { name: 'stock', field: { kind: 'integer' }, required: false },
    { name: 'code', field: { kind: 'string' }, required: true },
  ];
  const report = (name: string, inputs: ArtifactOperationInput[]): ArtifactOperation => ({
    name,
    kind: 'read',
    description: DESCRIPTION,
    inputs: { fields: inputs },
    result: { type: 'int' },
  });
  return {
    artifact_version: 1,
    operations: [
      { name: `${GADGET}.create`, kind: 'create', description: '', inputs: { fields: crudInputs } },
      {
        name: `${GADGET}.update`,
        kind: 'update',
        description: '',
        inputs: { fields: [refInput('record', GADGET), ...crudInputs.map((field) => ({ ...field, required: false }))] },
      },
      {
        name: `${GADGET}.delete`,
        kind: 'delete',
        description: '',
        inputs: { fields: [refInput('record', GADGET)] },
      },
      { name: `${GADGET}.read`, kind: 'read', description: '', inputs: { fields: [] } },
      report(TOTALS, []),
      report(INSPECT_AUTHORITY, [refInput('gadget', GADGET)]),
      {
        name: 'Shop.inspect',
        kind: 'read',
        description: 'Return visible gadget details.',
        inputs: { fields: [refInput('gadget', GADGET)] },
      },
    ],
    models: [gadget],
  };
}

interface AuthoritySetup {
  store: StoragePort;
  memberships: ReturnType<typeof createMemoryIdentityStore>;
  alice: SeededMember;
  policy: PolicyTable;
  registry: ReturnType<typeof loadArtifactDescriptors>['registry'];
}

async function setupAuthority(): Promise<AuthoritySetup> {
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const loaded = loadArtifactDescriptors(authoritySlice(), { by: 'members' });
  for (const name of [TOTALS, INSPECT_AUTHORITY]) {
    const def = loaded.registry.get(name);
    assert.ok(def !== undefined && isGeneratedOperationDef(def));
    bindAuthorityReportScope(def, { description: DESCRIPTION, source: SOURCE });
  }
  // Viewer grants cover titles only: stock is confidential to viewer reads,
  // so only the decision-mode grant can observe it.
  const policy = buildPolicyTable([
    { model: asModel(GADGET), secretFields: [], grants: [{ by: 'members', fields: ['title', 'code'] }] },
  ]);
  return { store, memberships, alice, policy, registry: loaded.registry };
}

function identityFor(member: SeededMember) {
  return makeIdentity({ membership: member.membership, email: member.user.email });
}

function readEnvelope(operation: string, inputs: Record<string, unknown> = {}): ReadEnvelope {
  return { operation, inputs };
}

async function seedStock(setup: AuthoritySetup, id: string, stock: string): Promise<StoredRow> {
  return seedRow(setup.store, asModel(GADGET), {
    id,
    data: { title: `item-${id}`, code: `C-${id}`, stock },
  });
}

describe('authority report decision boundary', () => {
  it('grants a typed result computed from decision-mode rows invisible to viewer reads', async () => {
    const setup = await setupAuthority();
    await seedStock(setup, 'first', '3');
    await seedStock(setup, 'second', '4');
    const revision = await setup.store.readRevision();

    const served = await invokeReadScenario({
      ...setup,
      envelope: readEnvelope(TOTALS),
      identity: identityFor(setup.alice),
      execute: async (call) => {
        assert.ok(call.decision !== undefined, 'authority execution offers decision reads');
        assert.equal(call.decision.scope, 'authority');
        const observed = await call.decision.query(asModel(GADGET));
        assert.equal(observed.revision, revision);
        return observed.rows.reduce((sum, row) => sum + Number(row.data['stock'] ?? 0), 0);
      },
    });
    assert.deepEqual(served, { result: 7, revision });

    // Viewer contrast: the same rows project without the confidential field.
    const viewer = await invokeRead({
      ...setup,
      envelope: readEnvelope(`${GADGET}.read`),
      identity: identityFor(setup.alice),
    });
    assert.equal(viewer.records.length, 2);
    for (const record of viewer.records) {
      assert.deepEqual(Object.keys(record.data).sort(), ['code', 'title']);
    }
  });

  it('loads decision refs unprojected while keeping stale/archive/missing identity', async () => {
    const setup = await setupAuthority();
    const row = await seedStock(setup, 'only', '9');
    const run = (inputs: Record<string, unknown>, store: StoragePort = setup.store) =>
      invokeReadScenario({
        ...setup,
        store,
        envelope: readEnvelope(INSPECT_AUTHORITY, inputs),
        identity: identityFor(setup.alice),
        execute: async (call) => {
          assert.deepEqual(call.recordRefs[0]!.row.data, { title: 'item-only', code: 'C-only', stock: '9' });
          return 1;
        },
      });
    const ok = await run({ gadget: { id: row.id, version: '1' } });
    assert.equal(ok.result, 1);

    assert.equal(
      (await captureStateError(() => run({ gadget: { id: row.id, version: '2' } }))).code,
      'conflict',
    );
    const archived: StoragePort = {
      ...setup.store,
      load: async () => ({ ...row, archivedAt: FIXED_NOW }),
    };
    assert.equal(
      (await captureStateError(() => run({ gadget: { id: row.id, version: '1' } }, archived))).code,
      'validation',
    );
    const missing: StoragePort = { ...setup.store, load: async () => null };
    assert.equal(
      (await captureStateError(() => run({ gadget: { id: row.id, version: '1' } }, missing))).code,
      'not_found',
    );
  });

  it('refuses viewer-mode reads of authority data instead of serving filtered rows', async () => {
    const setup = await setupAuthority();
    await seedStock(setup, 'hidden', '5');
    const error = await captureStateError(() =>
      invokeRead({ ...setup, envelope: readEnvelope(TOTALS), identity: identityFor(setup.alice) }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /authority report/);
    const pageError = await captureStateError(() =>
      invokeReadPage({
        registry: setup.registry,
        policy: setup.policy,
        store: setup.store,
        memberships: setup.memberships,
        envelope: readEnvelope(TOTALS),
        identity: identityFor(setup.alice),
        containment: new Map(),
      }),
    );
    assert.equal(pageError.code, 'validation');
    assert.match(pageError.message, /authority report/);
  });

  it('refuses undescribed authority bindings and untyped reports at bind time', async () => {
    const loaded = loadArtifactDescriptors(authoritySlice(), { by: 'members' });
    const totals = loaded.registry.get(TOTALS);
    assert.ok(totals !== undefined && isGeneratedOperationDef(totals));
    assert.equal(
      (await captureStateError(async () => {
        bindAuthorityReportScope(totals, { description: '', source: SOURCE });
      })).code,
      'validation',
    );
    const ordinary = loaded.registry.get(`${GADGET}.read`);
    assert.ok(ordinary !== undefined && isGeneratedOperationDef(ordinary));
    assert.equal(
      (await captureStateError(async () => {
        bindAuthorityReportScope(ordinary, { description: DESCRIPTION, source: SOURCE });
      })).code,
      'validation',
    );
  });

  it('leaves ordinary reads without a decision surface and byte-identical', async () => {
    const setup = await setupAuthority();
    const row = await seedStock(setup, 'plain', '2');
    const served = await invokeReadScenario({
      ...setup,
      envelope: readEnvelope('Shop.inspect', { gadget: { id: row.id, version: '1' } }),
      identity: identityFor(setup.alice),
      execute: async (call) => {
        assert.equal('decision' in call, false);
        return call.recordRefs[0]!.row.data['title'];
      },
    });
    // Ordinary refs stay viewer-projected: the confidential field is absent.
    assert.equal(served.result, 'item-plain');
    const viewer = await invokeRead({
      ...setup,
      envelope: readEnvelope(`${GADGET}.read`),
      identity: identityFor(setup.alice),
    });
    assert.deepEqual(viewer.records[0]?.data, { title: 'item-plain', code: 'C-plain' });
  });

  it('refuses by-denied callers before any decision read', async () => {
    const { store } = createTestMemoryStorage();
    const memberships = createMemoryIdentityStore();
    const alice = await seedMember(memberships, { isOwner: false });
    const loaded = loadArtifactDescriptors(authoritySlice(), { by: 'owner' });
    const def = loaded.registry.get(TOTALS);
    assert.ok(def !== undefined && isGeneratedOperationDef(def));
    bindAuthorityReportScope(def, { description: DESCRIPTION, source: SOURCE });
    const policy = buildPolicyTable([
      { model: asModel(GADGET), secretFields: [], grants: [{ by: 'members', fields: ['title', 'code'] }] },
    ]);
    let ran = false;
    const error = await captureStateError(() =>
      invokeReadScenario({
        registry: loaded.registry,
        policy,
        store,
        memberships,
        envelope: readEnvelope(TOTALS),
        identity: makeIdentity({ membership: alice.membership, email: alice.user.email }),
        execute: async () => {
          ran = true;
          return 0;
        },
      }),
    );
    assert.equal(error.code, 'forbidden');
    assert.equal(ran, false);
  });

  it('evaluates decision queries under owner authority with a bounded default', async () => {
    const setup = await setupAuthority();
    await seedStock(setup, 'a', '1');
    await seedStock(setup, 'b', '2');
    // Storage never receives the limit (limits fail in memory, never push
    // down), so the spy observes authority while the overflow case below
    // proves the bound value end to end.
    const seen: unknown[] = [];
    const store: StoragePort = {
      ...setup.store,
      query: async (spec) => {
        seen.push(spec.authority);
        return setup.store.query(spec);
      },
    };
    const served = await invokeReadScenario({
      ...setup,
      store,
      envelope: readEnvelope(TOTALS),
      identity: identityFor(setup.alice),
      execute: async (call) => {
        const observed = await call.decision!.query(asModel(GADGET));
        return observed.rows.length;
      },
    });
    assert.equal(served.result, 2);
    assert.ok(seen.length >= 1);
    for (const authority of seen) assert.equal(authority, 'owner');
  });

  it('bounds default decision scans instead of serving unbounded domains', async () => {
    const setup = await setupAuthority();
    for (let index = 0; index < 1001; index += 1) {
      await seedStock(setup, `bulk-${index}`, '1');
    }
    const error = await captureStateError(() =>
      invokeReadScenario({
        ...setup,
        envelope: readEnvelope(TOTALS),
        identity: identityFor(setup.alice),
        execute: async (call) => {
          await call.decision!.query(asModel(GADGET));
          return 0;
        },
      }),
    );
    assert.equal(error.code, 'validation');
  });

  it('fails decision queries over their limit instead of truncating', async () => {
    const setup = await setupAuthority();
    await seedStock(setup, 'a', '1');
    await seedStock(setup, 'b', '2');
    const error = await captureStateError(() =>
      invokeReadScenario({
        ...setup,
        envelope: readEnvelope(TOTALS),
        identity: identityFor(setup.alice),
        execute: async (call) => {
          await call.decision!.query(asModel(GADGET), { limit: 1 });
          return 0;
        },
      }),
    );
    assert.equal(error.code, 'validation');
  });

  it('voids the grant when state moves during decision evaluation', async () => {
    const setup = await setupAuthority();
    await seedStock(setup, 'fence', '1');
    const error = await captureStateError(() =>
      invokeReadScenario({
        ...setup,
        envelope: readEnvelope(TOTALS),
        identity: identityFor(setup.alice),
        execute: async (call) => {
          await call.decision!.query(asModel(GADGET));
          await seedStock(setup, 'late', '5');
          return 0;
        },
      }),
    );
    assert.equal(error.code, 'conflict');
  });

  it('voids the grant when caller membership changes during decision evaluation', async () => {
    const setup = await setupAuthority();
    await seedStock(setup, 'roles', '1');
    let changed = false;
    const memberships = {
      ...setup.memberships,
      findMembership: async (team: string, user: string) => {
        const member = await setup.memberships.findMembership(team, user);
        return member !== null && changed ? { ...member, is_owner: true } : member;
      },
    };
    const error = await captureStateError(() =>
      invokeReadScenario({
        ...setup,
        memberships,
        envelope: readEnvelope(TOTALS),
        identity: identityFor(setup.alice),
        execute: async () => {
          changed = true;
          return 0;
        },
      }),
    );
    assert.equal(error.code, 'forbidden');
  });
});
