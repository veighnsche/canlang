/**
 * Outcome 9 REVIEW-10 typed-int filter fix (Lane A): authority data-only
 * Int filters match the canonical Values int wire through the actual host
 * seam (`call.decision.query` into owner `queryRecords`).
 *
 * Stored ints are int64 decimal strings, so the legacy same-type
 * comparison failed closed on every Int filter (and would misorder
 * string pairs). The `where` ASTs below are byte-identical to what the
 * compiler emits for the real fixture
 * `compiler/tests/fixtures/scope-authority-int-filter.can` (proven by
 * `scope_authority_reports::authority_int_filters_emit_canonical_string_wire`);
 * this suite proves those exact selections serve the source-expected
 * rows/count over canonically admitted string-stored ints, with null
 * cases and failure behavior preserved.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ArtifactModel,
  ArtifactModelField,
  ArtifactOperation,
  ArtifactOperationInput,
  QueryPredicate,
  ReadEnvelope,
  StoragePort,
} from '@canlang/contracts';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from './registry.js';
import { isGeneratedOperationDef } from './registry.js';
import { buildModelTableFromCanonical } from '../mutation/models.js';
import { generatedCrudExecute } from '../mutation/crud.js';
import {
  bindAuthorityReportScope,
  invoke,
  invokeReadScenario,
} from './invoke.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import { buildPolicyTable, type PolicyTable } from '../policy/grants.js';
import {
  FIXED_NOW,
  asModel,
  createMemoryIdentityStore,
  makeEnvelope,
  makeIdentity,
  seedMember,
  uuidv7,
  type SeededMember,
} from '../../test/invocation/fixtures.js';

const APP = 'acme-app';
const GADGET = 'Shop.Gadget';
const TOTALS = 'Shop.totals';
const SOURCE = { path: 'scope-authority-int-filter.can', sha256: 'b'.repeat(64), module: 'Shop' };
const DESCRIPTION = 'Confidential filtered stock totals granted to members.';

function modelField(name: string, field: ArtifactModelField['field'], required: boolean): ArtifactModelField {
  return { name, field, required, serverOnly: false };
}

function intFilterSlice(): ArtifactDescriptorSlice {
  const gadget: ArtifactModel = {
    name: GADGET,
    fields: [
      modelField('title', { kind: 'string' }, true),
      modelField('stock', { kind: 'integer' }, false),
    ],
    deleteMode: 'archive',
  };
  const create: ArtifactOperation = {
    name: `${GADGET}.create`,
    kind: 'create',
    description: '',
    inputs: {
      fields: [
        { name: 'title', field: { kind: 'string' }, required: true },
        { name: 'stock', field: { kind: 'integer' }, required: false },
      ] as ArtifactOperationInput[],
    },
  };
  const report: ArtifactOperation = {
    name: TOTALS,
    kind: 'read',
    description: DESCRIPTION,
    inputs: { fields: [] },
    result: { type: 'int' },
  };
  return { artifact_version: 1, operations: [create, report], models: [gadget] };
}

interface FilterSetup {
  store: StoragePort;
  memberships: ReturnType<typeof createMemoryIdentityStore>;
  alice: SeededMember;
  policy: PolicyTable;
  registry: ReturnType<typeof loadArtifactDescriptors>['registry'];
  models: ReturnType<typeof loadArtifactDescriptors>['models'];
}

async function setupFilter(): Promise<FilterSetup> {
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const loaded = loadArtifactDescriptors(intFilterSlice(), { by: 'members' });
  const def = loaded.registry.get(TOTALS);
  assert.ok(def !== undefined && isGeneratedOperationDef(def));
  bindAuthorityReportScope(def, { description: DESCRIPTION, source: SOURCE });
  const policy = buildPolicyTable([
    { model: asModel(GADGET), secretFields: [], grants: [{ by: 'members', fields: ['title'] }] },
  ]);
  return { store, memberships, alice, policy, registry: loaded.registry, models: loaded.models };
}

function identityFor(member: SeededMember) {
  return makeIdentity({ membership: member.membership, email: member.user.email });
}

let opSeq = 500;
function nextOperationId(): string {
  opSeq += 1;
  return uuidv7(FIXED_NOW, opSeq);
}

/** Admit one row through canonical admission; returns the created row id. */
async function admitStock(setup: FilterSetup, inputs: Record<string, unknown>): Promise<string> {
  const full = loadArtifactDescriptors(intFilterSlice(), { by: 'members' });
  const table = buildModelTableFromCanonical(full.models, { refs: full.refs });
  const execute = generatedCrudExecute({ table, store: setup.store });
  const operationId = nextOperationId();
  const result = await invoke({
    registry: setup.registry,
    envelope: makeEnvelope(`${GADGET}.create`, operationId, inputs),
    identity: identityFor(setup.alice),
    app: APP,
    source: 'test',
    store: setup.store,
    memberships: setup.memberships,
    clock: { nowMs: () => FIXED_NOW },
    execute,
  });
  assert.equal(result.status, 'committed');
  const created = result.result as { id: string; data: Record<string, unknown> };
  assert.equal(created.id, operationId);
  for (const value of Object.values(created.data)) {
    assert.ok(typeof value === 'string', `stored wire stays canonical strings: ${JSON.stringify(created.data)}`);
  }
  return created.id;
}

async function decisionIds(
  setup: FilterSetup,
  where: QueryPredicate,
): Promise<{ ids: string[]; count: number }> {
  const served = await invokeReadScenario({
    registry: setup.registry,
    models: setup.models,
    policy: setup.policy,
    store: setup.store,
    memberships: setup.memberships,
    envelope: { operation: TOTALS, inputs: {} } as ReadEnvelope,
    identity: identityFor(setup.alice),
    execute: async (call) => {
      assert.ok(call.decision !== undefined, 'authority execution offers decision reads');
      const observed = await call.decision.query(asModel(GADGET), { where });
      return { ids: observed.rows.map((row) => row.id).sort(), count: observed.rows.length };
    },
  });
  return served.result as { ids: string[]; count: number };
}

describe('authority int filters match the canonical int wire', () => {
  it('serves equality, 2-vs-10 ordering, negatives and big ints through decision reads', async () => {
    const setup = await setupFilter();
    const two = await admitStock(setup, { title: 'item-two', stock: '2' });
    const ten = await admitStock(setup, { title: 'item-ten', stock: '10' });
    const neg = await admitStock(setup, { title: 'item-neg', stock: '-5' });
    const big = await admitStock(setup, { title: 'item-big', stock: '9007199254740993' });

    assert.deepEqual(await decisionIds(setup, { op: 'eq', field: 'stock', value: '10' }), {
      ids: [ten],
      count: 1,
    });
    // The 2-vs-10 discriminator: lexicographic order would match nothing.
    assert.deepEqual(await decisionIds(setup, { op: 'gt', field: 'stock', value: '2' }), {
      ids: [big, ten].sort(),
      count: 2,
    });
    assert.deepEqual(await decisionIds(setup, { op: 'lt', field: 'stock', value: '0' }), {
      ids: [neg],
      count: 1,
    });
    // Beyond safe integer, exact with no Number routing.
    assert.deepEqual(
      await decisionIds(setup, { op: 'eq', field: 'stock', value: '9007199254740993' }),
      { ids: [big], count: 1 },
    );
    assert.deepEqual(
      await decisionIds(setup, { op: 'between', field: 'stock', lo: '2', hi: '10' }),
      { ids: [ten, two].sort(), count: 2 },
    );
    // Composed text + int filters keep their own semantics per field.
    assert.deepEqual(
      await decisionIds(setup, {
        op: 'and',
        args: [
          { op: 'eq', field: 'title', value: 'item-ten' },
          { op: 'gt', field: 'stock', value: '2' },
        ],
      }),
      { ids: [ten], count: 1 },
    );
  });

  it('keeps null/missing comparisons false for every operator', async () => {
    const setup = await setupFilter();
    const two = await admitStock(setup, { title: 'item-two', stock: '2' });
    const bare = await admitStock(setup, { title: 'item-bare' });
    assert.deepEqual(await decisionIds(setup, { op: 'is_null', field: 'stock' }), {
      ids: [bare],
      count: 1,
    });
    // The missing row never matches any of the six operators; the stored
    // row matches exactly its numeric outcomes.
    const cases: ReadonlyArray<{ op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; ids: string[] }> = [
      { op: 'eq', ids: [two] },
      { op: 'ne', ids: [] },
      { op: 'lt', ids: [] },
      { op: 'lte', ids: [two] },
      { op: 'gt', ids: [] },
      { op: 'gte', ids: [two] },
    ];
    for (const { op, ids } of cases) {
      assert.deepEqual(
        await decisionIds(setup, { op, field: 'stock', value: '2' }),
        { ids, count: ids.length },
        `${op} never matches the missing row`,
      );
    }
  });
});
