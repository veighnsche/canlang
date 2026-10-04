/**
 * Lane 03 S4 visibility tests (worker B): grant matching narrows rows,
 * matching grants union fields, revoked/unknown callers see nothing, and
 * owner authority reads full rows. Memory StoragePort + local membership
 * double; engine is adapter-agnostic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { queryRecords } from '../../src/query/index.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import type { SeededMember } from '../invocation/fixtures.js';
import {
  FIXED_NOW,
  REVIEWER,
  asModel,
  grant,
  modelPolicy,
  ownerInput,
  policyTable,
  seedRows,
  seedStandardTeam,
  viewerInput,
  type EngineCallOpts,
} from './fixtures.js';

const MODEL = asModel('Acme.Expense');

async function setup() {
  const store = createMemoryStorage();
  const std = await seedStandardTeam();
  const policy = policyTable(
    modelPolicy(MODEL, {
      grants: [grant('members', ['title', 'amount']), grant({ role: REVIEWER }, ['review_note'])],
    }),
  );
  await seedRows(store, MODEL, [
    {
      id: 'rec-1',
      created: FIXED_NOW,
      data: { title: 'Alpha', amount: 10, review_note: 'ok-1', internal_note: 'denied-1' },
    },
    {
      id: 'rec-2',
      created: FIXED_NOW + 1,
      data: { title: 'Beta', amount: 20, review_note: 'ok-2', internal_note: 'denied-2' },
    },
  ]);
  return { store, std, policy };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function base(s: Setup, caller: SeededMember): EngineCallOpts {
  return {
    store: s.store,
    memberships: s.std.memberships,
    policy: s.policy,
    model: MODEL,
    scope: s.std.team,
    caller,
  };
}

function dataKeys(record: { readonly data: Readonly<Record<string, unknown>> }): string[] {
  return Object.keys(record.data).sort();
}

describe('visibility', () => {
  it('matching grants union fields across grants', async () => {
    const s = await setup();
    const carol = await queryRecords(viewerInput(base(s, s.std.carol)));
    assert.equal(carol.records.length, 2);
    assert.deepEqual(dataKeys(carol.records[0]!), ['amount', 'review_note', 'title']);
    assert.deepEqual(carol.records[0]!.data, { title: 'Alpha', amount: 10, review_note: 'ok-1' });

    const alice = await queryRecords(viewerInput(base(s, s.std.alice)));
    assert.equal(alice.records.length, 2);
    assert.deepEqual(dataKeys(alice.records[0]!), ['amount', 'title']);
  });

  it('non-matching rows are hidden entirely', async () => {
    const s = await setup();
    const outsider = await queryRecords(viewerInput(base(s, s.std.outsider)));
    assert.equal(outsider.records.length, 0);

    const ghost = await queryRecords({
      ...viewerInput(base(s, s.std.alice)),
      context: { actorUserId: 'user-ghost', teamId: s.std.team.team_id },
    });
    assert.equal(ghost.records.length, 0);

    const anon = await queryRecords({
      ...viewerInput(base(s, s.std.alice)),
      context: { actorUserId: null, teamId: null },
    });
    assert.equal(anon.records.length, 0);
  });

  it('a model with no policy denies viewers entirely', async () => {
    const s = await setup();
    const other = await queryRecords({
      ...viewerInput(base(s, s.std.alice)),
      model: asModel('Acme.Unlisted'),
    });
    assert.equal(other.records.length, 0);
  });

  it('a public grant is visible without membership', async () => {
    const s = await setup();
    const policy = policyTable(modelPolicy(MODEL, { grants: [grant('public', ['title'])] }));
    const ghost = await queryRecords({
      ...viewerInput({ ...base(s, s.std.alice), policy }),
      context: { actorUserId: null, teamId: null },
    });
    assert.equal(ghost.records.length, 2);
    assert.deepEqual(ghost.records[0]!.data, { title: 'Alpha' });
  });

  it('when row-match narrows per-row', async () => {
    const store = createMemoryStorage();
    const std = await seedStandardTeam();
    const policy = policyTable(
      modelPolicy(MODEL, {
        grants: [
          grant('members', ['title'], { op: 'eq', field: 'status', value: 'open' }),
        ],
      }),
    );
    await seedRows(store, MODEL, [
      { id: 'rec-open', data: { title: 'Open', status: 'open' } },
      { id: 'rec-closed', data: { title: 'Closed', status: 'closed' } },
    ]);
    const seen = await queryRecords(
      viewerInput({ store, memberships: std.memberships, policy, model: MODEL, scope: std.team, caller: std.alice }),
    );
    assert.deepEqual(
      seen.records.map((record) => record.id),
      ['rec-open'],
    );
    assert.deepEqual(seen.records[0]!.data, { title: 'Open' });
  });

  it('a declared role requires its explicit grant; the owner sees nothing extra', async () => {
    const s = await setup();
    const owner = await queryRecords(viewerInput(base(s, s.std.owner)));
    assert.equal(owner.records.length, 2);
    assert.deepEqual(dataKeys(owner.records[0]!), ['amount', 'title']);
    assert.ok(!('review_note' in owner.records[0]!.data));
  });

  it('revoked membership hides rows', async () => {
    const s = await setup();
    const before = await queryRecords(viewerInput(base(s, s.std.alice)));
    assert.equal(before.records.length, 2);
    await s.std.memberships.removeMembership(s.std.alice.membership.membership_id);
    const after = await queryRecords(viewerInput(base(s, s.std.alice)));
    assert.equal(after.records.length, 0);
  });

  it('owner authority returns full rows including denied fields', async () => {
    const s = await setup();
    const owned = await queryRecords(ownerInput(base(s, s.std.owner)));
    assert.equal(owned.rows.length, 2);
    assert.deepEqual(owned.rows[0]!.data, {
      title: 'Alpha',
      amount: 10,
      review_note: 'ok-1',
      internal_note: 'denied-1',
    });
    assert.deepEqual(owned.rows[1]!.data, {
      title: 'Beta',
      amount: 20,
      review_note: 'ok-2',
      internal_note: 'denied-2',
    });
  });

  it("where evaluates over each row's own projected values (no cross-grant leak)", async () => {
    const store = createMemoryStorage();
    const std = await seedStandardTeam();
    const policy = policyTable(
      modelPolicy(MODEL, {
        grants: [
          grant('members', ['salary'], { op: 'eq', field: 'kind', value: 'a' }),
          grant('members', ['title']),
        ],
      }),
    );
    await seedRows(store, MODEL, [
      { id: 'rec-1', data: { kind: 'a', salary: 100, title: 'x' } },
      { id: 'rec-2', data: { kind: 'b', salary: 200, title: 'y' } },
    ]);
    const call = {
      store,
      memberships: std.memberships,
      policy,
      model: MODEL,
      scope: std.team,
      caller: std.alice,
    };
    // rec-2's salary is ungranted-for-row: it must not match a salary predicate.
    const seen = await queryRecords(
      viewerInput({ ...call, where: { op: 'gt', field: 'salary', value: 150 } }),
    );
    assert.deepEqual(seen.records.map((record) => record.id), []);
    // ...but rec-2 stays visible with only its title projected.
    const all = await queryRecords(viewerInput(call));
    assert.deepEqual(
      all.records.map((record) => record.id).sort(),
      ['rec-1', 'rec-2'],
    );
    const rec2 = all.records.find((record) => record.id === 'rec-2')!;
    assert.deepEqual(rec2.data, { title: 'y' });
  });
});
