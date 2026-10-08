/**
 * Lane 03 S4 projection tests (worker B): leaf grants project partial
 * objects, granted paths project whole subtrees, metadata is always present,
 * secrets never leak, and secret-covering grants fail at build time. Memory
 * StoragePort + local membership double.
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { queryAggregate, queryRecords } from '../../src/query/index.js';
import { queryEventualRecords } from '../../src/query/engine.js';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { captureFailure } from '../invocation/fixtures.js';
import {
  FIXED_NOW,
  asModel,
  grant,
  modelPolicy,
  notification,
  policyTable,
  secret,
  seedRows,
  seedStandardTeam,
  viewerInput,
  type PolicyTable,
} from './fixtures.js';

const MODEL = asModel('Acme.Delivery');

async function setup(policy: PolicyTable) {
  const store = createMemoryStorage();
  const std = await seedStandardTeam();
  await seedRows(store, MODEL, [
    {
      id: 'rec-1',
      created: FIXED_NOW,
      updated: FIXED_NOW + 5,
      createdBy: 'user-seeder',
      updatedBy: 'user-seeder',
      data: {
        title: 'Parcel',
        notification: notification('sent', { handle: 'h-1', attempts: 2 }),
        token: secret(),
      },
    },
  ]);
  return { store, std, policy };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function firstRecord(s: Setup) {
  const seen = await queryRecords({
    store: s.store,
    memberships: s.std.memberships,
    policy: s.policy,
    model: MODEL,
    authority: 'viewer',
    context: { actorUserId: s.std.alice.user.user_id, teamId: s.std.team.team_id },
  });
  assert.equal(seen.records.length, 1);
  return seen.records[0]!;
}

describe('projection', () => {
  it('a leaf grant projects the partial object; siblings are absent, never null', async () => {
    const s = await setup(
      policyTable(modelPolicy(MODEL, { grants: [grant('members', ['title', 'notification.status'])] })),
    );
    const record = await firstRecord(s);
    assert.deepEqual(record.data['title'], 'Parcel');
    const projected = record.data['notification'] as Record<string, unknown>;
    assert.deepEqual(projected, { status: 'sent' });
    assert.ok(!('handle' in projected), 'sibling leaf handle must be absent, not null');
    assert.ok(!('attempts' in projected), 'sibling leaf attempts must be absent, not null');
    assert.ok(!('token' in record.data));
  });

  it('a granted path projects its whole subtree', async () => {
    const s = await setup(
      policyTable(modelPolicy(MODEL, { grants: [grant('members', ['notification'])] })),
    );
    const record = await firstRecord(s);
    assert.deepEqual(record.data['notification'], { status: 'sent', handle: 'h-1', attempts: 2 });
    assert.ok(!('title' in record.data));
  });

  it('overlapping grants project the complete union in either grant order', async () => {
    const narrow = grant('members', ['notification.status']);
    const wide = grant('members', ['notification']);
    const full = { status: 'sent', handle: 'h-1', attempts: 2 };
    for (const grants of [
      [narrow, wide],
      [wide, narrow],
    ]) {
      const s = await setup(policyTable(modelPolicy(MODEL, { grants })));
      const record = await firstRecord(s);
      assert.deepEqual(record.data['notification'], full);
    }
  });

  it('metadata is always present with stored values', async () => {
    const s = await setup(
      policyTable(modelPolicy(MODEL, { grants: [grant('members', ['title'])] })),
    );
    const record = await firstRecord(s);
    assert.equal(record.id, 'rec-1');
    assert.equal(record.version, 1);
    assert.equal(record.created, FIXED_NOW);
    assert.equal(record.updated, FIXED_NOW + 5);
    assert.equal(record.createdBy, 'user-seeder');
    assert.equal(record.updatedBy, 'user-seeder');
    assert.equal(record.archivedAt, null);
  });

  it('a metadata path in a grant is harmless; metadata stays complete', async () => {
    const s = await setup(
      policyTable(
        modelPolicy(MODEL, { grants: [grant('members', ['id', 'title'])] }),
      ),
    );
    const record = await firstRecord(s);
    assert.equal(record.id, 'rec-1');
    assert.equal(record.version, 1);
    assert.deepEqual(record.data, { title: 'Parcel' });
  });

  it('a SecretValue is dropped even when its path is granted', async () => {
    const s = await setup(
      policyTable(modelPolicy(MODEL, { grants: [grant('members', ['title', 'token'])] })),
    );
    const record = await firstRecord(s);
    assert.deepEqual(record.data, { title: 'Parcel' });
    assert.ok(!('token' in record.data), 'granted secret value must be absent, not null');
  });

  it('a grant above a secret path carves the secret subtree out', async () => {
    const store = createMemoryStorage();
    const std = await seedStandardTeam();
    const policy = policyTable(
      modelPolicy(MODEL, {
        secretFields: ['settings.token'],
        grants: [grant('members', ['settings'])],
      }),
    );
    await seedRows(store, MODEL, [
      { id: 'rec-1', data: { settings: { theme: 'dark', token: 't-secret' } } },
    ]);
    const seen = await queryRecords({
      store,
      memberships: std.memberships,
      policy,
      model: MODEL,
      authority: 'viewer',
      context: { actorUserId: std.alice.user.user_id, teamId: std.team.team_id },
    });
    assert.equal(seen.records.length, 1);
    assert.deepEqual(seen.records[0]!.data, { settings: { theme: 'dark' } });
  });

  it('buildPolicyTable rejects secret-covering grants with a plain Error', async () => {
    for (const fields of [['api_key'], ['credentials.password']]) {
      const failure = await captureFailure(() =>
        policyTable(
          modelPolicy(MODEL, {
            secretFields: fields[0] === 'api_key' ? ['api_key'] : ['credentials'],
            grants: [grant('members', fields)],
          }),
        ),
      );
      assert.ok(failure instanceof Error, 'expected an Error');
      assert.ok(!(failure instanceof StateError), 'expected a plain Error, not a StateError');
    }
  });

  it('a declared secret under an array is carved out of every element', async () => {
    const store = createMemoryStorage();
    const std = await seedStandardTeam();
    const policy = policyTable(
      modelPolicy(MODEL, {
        secretFields: ['items.token'],
        grants: [grant('members', ['items'])],
      }),
    );
    await seedRows(store, MODEL, [
      {
        id: 'rec-1',
        data: { items: [{ token: 's-1', label: 'a' }, { token: 's-2', label: 'b' }] },
      },
    ]);
    const seen = await queryRecords({
      store,
      memberships: std.memberships,
      policy,
      model: MODEL,
      authority: 'viewer',
      context: { actorUserId: std.alice.user.user_id, teamId: std.team.team_id },
    });
    assert.equal(seen.records.length, 1);
    assert.deepEqual(seen.records[0]!.data, { items: [{ label: 'a' }, { label: 'b' }] });
  });

  it('buildPolicyTable rejects when row-matches touching secrets', async () => {
    const failure = await captureFailure(() =>
      policyTable(
        modelPolicy(MODEL, {
          secretFields: ['pin'],
          grants: [grant('members', ['title'], { op: 'eq', field: 'pin', value: '1234' })],
        }),
      ),
    );
    assert.ok(failure instanceof Error, 'expected an Error');
    assert.ok(!(failure instanceof StateError), 'expected a plain Error, not a StateError');
    assert.match(failure.message, /secret/);
  });

  it('buildPolicyTable rejects malformed by predicates with a plain Error', async () => {
    for (const by of [
      'nobody' as 'members',
      { role: '' } as { role: string },
      { and: [] } as unknown as 'members',
    ]) {
      const failure = await captureFailure(() =>
        policyTable(modelPolicy(MODEL, { grants: [grant(by as unknown as 'members', ['title'])] })),
      );
      assert.ok(failure instanceof Error, 'expected an Error');
      assert.ok(!(failure instanceof StateError), 'expected a plain Error, not a StateError');
    }
  });

  it('buildPolicyTable rejects when predicates with non-string fields', async () => {
    const failure = await captureFailure(() =>
      policyTable(
        modelPolicy(MODEL, {
          grants: [
            grant('members', ['title'], {
              op: 'eq',
              field: 5 as unknown as string,
              value: 'x',
            }),
          ],
        }),
      ),
    );
    assert.ok(failure instanceof Error, 'expected an Error');
    assert.ok(!(failure instanceof StateError), 'expected a plain Error, not a StateError');
  });

  it('post-build mutation of the input policy cannot alter enforcement', async () => {
    const input = grant('members', ['title']);
    const policy = policyTable(modelPolicy(MODEL, { grants: [input] }));
    (input.fields as unknown as string[]).push('notification');
    (input as unknown as { by: unknown }).by = 'public';
    const s = await setup(policy);
    const record = await firstRecord(s);
    assert.deepEqual(record.data, { title: 'Parcel' });
    const outsider = await queryRecords({
      store: s.store,
      memberships: s.std.memberships,
      policy,
      model: MODEL,
      authority: 'viewer',
      context: { actorUserId: s.std.outsider.user.user_id, teamId: null },
    });
    assert.equal(outsider.records.length, 0);
  });
});


test('trusted viewer predicates see matching-grant snapshots and cannot mutate ordered output', async () => {
  const store = createMemoryStorage();
  const std = await seedStandardTeam();
  const policy = policyTable(modelPolicy(MODEL, { secretFields: ['settings.token'], grants: [
    grant('members', ['title'], { op: 'eq', field: 'title', value: 'Narrow' }),
    grant('members', ['title', 'settings'], { op: 'eq', field: 'title', value: 'Wide' }),
  ] }));
  await seedRows(store, MODEL, [
    { id: 'narrow', data: { title: 'Narrow', settings: { score: 99, token: 'hidden' } } },
    { id: 'wide', data: { title: 'Wide', settings: { score: 20, token: 'hidden' } } },
    { id: 'invisible', data: { title: 'None', settings: { score: 100 } } },
    { id: 'archived', archivedAt: FIXED_NOW, data: { title: 'Wide', settings: { score: 30 } } },
  ]);
  const input = { store, memberships: std.memberships, policy, model: MODEL,
    authority: 'viewer' as const, context: { actorUserId: std.alice.user.user_id, teamId: std.team.team_id } };
  const visited: string[] = [];
  const result = await queryRecords({ ...input, limit: 1, order: [{ field: 'title', direction: 'desc' }],
    predicate: async (record) => {
      visited.push(record.id);
      assert.equal(Object.hasOwn(record, 'model'), false);
      assert.equal(Object.hasOwn(record, 'membership'), false);
      const settings = record.data['settings'] as Record<string, unknown> | undefined;
      if (settings === undefined) return false;
      assert.deepEqual(settings, { score: 20 });
      settings['score'] = 999;
      (record.data as Record<string, unknown>)['title'] = 'Mutated';
      (record as { id: string }).id = 'mutated';
      return true;
    },
  });
  assert.deepEqual(visited.sort(), ['narrow', 'wide']);
  assert.deepEqual(result.records.map((record) => ({ id: record.id, data: record.data })), [
    { id: 'wide', data: { title: 'Wide', settings: { score: 20 } } },
  ]);
  const ordered = await queryRecords({ ...input, predicate: () => true,
    order: [{ field: 'title', direction: 'desc' }], limit: 2 });
  assert.deepEqual(ordered.records.map((record) => record.id), ['wide', 'narrow']);
});

test('trusted source predicates are rejected on owner, aggregate and eventual routes before storage', async () => {
  const s = await setup(policyTable(modelPolicy(MODEL, { grants: [grant('members', ['title'])] })));
  let reads = 0;
  const store = { ...s.store, readRevision: async () => { reads += 1; return s.store.readRevision(); } };
  const input = { store, memberships: s.std.memberships, policy: s.policy, model: MODEL,
    context: { actorUserId: s.std.alice.user.user_id, teamId: s.std.team.team_id },
    predicate: () => { throw new Error('callback on disallowed route'); } };
  for (const run of [
    () => queryRecords({ ...input, authority: 'owner' }),
    () => queryAggregate({ ...input, authority: 'viewer', spec: { op: 'count' } }),
    () => queryAggregate({ ...input, authority: 'owner', spec: { op: 'count' } }),
    () => queryEventualRecords({ ...input, authority: 'viewer' }),
    () => queryEventualRecords({ ...input, authority: 'owner' }),
  ]) {
    await assert.rejects(run, (error: unknown) => error instanceof StateError &&
      error.code === 'validation' && /current viewer record query/.test(error.message));
  }
  assert.equal(reads, 0);
});
