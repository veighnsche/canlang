import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanonicalModelDescriptor, MembershipSnapshot, RoleGrant } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '../../src/errors.js';
import { buildPolicyTable, type InterimGrant } from '../../src/policy/grants.js';
import type { ByPredicate, MembershipReader } from '../../src/policy/roles.js';
import { projectSavedRecordForViewer, queryRecordsPage } from '../../src/query/engine.js';
import { queryAggregate, queryRecords } from '../../src/query/index.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { makeRow } from '../invocation/fixtures.js';
import { asModel, FIXED_NOW, grant, modelPolicy, seedRows } from './fixtures.js';

const MODEL = asModel('Acme.Assignment');
const TEAM = 'team';
const ROLE = 'Acme.reviewer';
const AT = new Date(FIXED_NOW).toISOString();
const declaration: CanonicalModelDescriptor = {
  name: MODEL, deleteMode: 'archive', fields: {
    reviewer: { valueType: 'user?', nullable: true, required: false, serverOnly: false },
    title: { valueType: 'text', required: true, serverOnly: false },
    score: { valueType: 'int', required: true, serverOnly: false },
  },
};
const subject = (role = ROLE) => ({ roleSubject: { role, person: { model: MODEL, field: 'reviewer' } } });
const roleGrant = (role = ROLE, by = 'caller'): RoleGrant => ({ role, granted_at: AT, granted_by: by });
function policy(grants: readonly InterimGrant[] = [grant(subject(), ['title'])]) {
  return buildPolicyTable([modelPolicy(MODEL, { secretFields: ['settings.token'], grants })], [declaration]);
}
async function setup(grants?: readonly InterimGrant[]) {
  const identity = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const caller = await identity.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false,
    roles: [roleGrant('Acme.reader')] });
  const reviewer = await identity.createMembership({ team_id: TEAM, user_id: 'reviewer', is_owner: false,
    roles: [roleGrant(), roleGrant('Acme.other')] });
  await identity.createMembership({ team_id: TEAM, user_id: 'ordinary', is_owner: true, roles: [] });
  const store = createMemoryStorage();
  const table = policy(grants);
  const input = { authority: 'viewer' as const, model: MODEL, modelDescriptor: declaration,
    store, memberships: identity, policy: table, context: { actorUserId: 'caller', teamId: TEAM } };
  return { identity, caller, reviewer, store, input, table };
}
const refuses = (error: unknown) => error instanceof StateError &&
  ['forbidden', 'validation', 'limit', 'conflict'].includes(error.code);

// Successful snapshots always come from Identity's actual producer. Wrappers only
// observe requests or corrupt those produced observations for refusal controls.
test('different row subjects select grants and projected data before where, order and aggregate', async () => {
  const s = await setup([grant('public', ['title']), grant(subject(), ['score', 'settings'])]);
  await seedRows(s.store, MODEL, [
    { id: 'hidden-score', data: { reviewer: { id: 'ordinary' }, title: 'A', score: '999',
      settings: { label: 'denied', token: 'secret' } } },
    { id: 'visible-score', data: { reviewer: { id: 'reviewer' }, title: 'B', score: '5',
      settings: { label: 'visible', token: 'secret' } } },
  ]);
  const result = await queryRecords({ ...s.input, order: [{ field: 'score', direction: 'desc' }] });
  assert.deepEqual(result.records.map(r => ({ id: r.id, data: r.data })), [
    { id: 'visible-score', data: { title: 'B', score: '5', settings: { label: 'visible' } } },
    { id: 'hidden-score', data: { title: 'A' } },
  ]);
  const filtered = await queryRecords({ ...s.input, where: { op: 'eq', field: 'score', value: '999' } });
  assert.deepEqual(filtered.records, []);
  const minimum = await queryAggregate({ ...s.input, spec: { op: 'min', field: 'score' } });
  assert.equal(minimum.result.value, '5');
});

test('caller and all row subjects are coherently captured before any generated predicate', async () => {
  const s = await setup([grant({ and: [{ role: 'Acme.reader' }, subject()] }, ['title'])]);
  await seedRows(s.store, MODEL, [
    { id: 'one', data: { reviewer: { id: 'reviewer' }, title: 'one' } },
    { id: 'two', data: { reviewer: { id: 'ordinary' }, title: 'two' } },
  ]);
  const requests: string[][] = [];
  const memberships: MembershipReader = { ...s.identity,
    findMembershipsSnapshot: async (team, users) => {
      requests.push([...users]);
      return s.identity.findMembershipsSnapshot(team, users);
    },
  };
  let predicates = 0;
  const result = await queryRecords({ ...s.input, memberships, predicate: record => {
    predicates++;
    assert.deepEqual(new Set(requests[0]), new Set(['caller', 'reviewer', 'ordinary']));
    assert.deepEqual(record.data, { title: 'one' });
    assert.equal(Object.hasOwn(record, 'membership'), false);
    return true;
  } });
  assert.equal(predicates, 1);
  assert.deepEqual(result.records.map(r => r.id), ['one']);
  assert(requests.length >= 2, 'complete authority is rechecked after callback');
  assert.deepEqual(requests.at(-1), requests[0]);
});

test('static grant is cached across rows and a lazy row branch performs no subject reads', async () => {
  for (const by of [
    { roleSubject: { role: ROLE, person: 'reviewer' } },
    { or: ['public', subject()] },
  ] as ByPredicate[]) {
    const s = await setup([grant(by, ['title'])]);
    await seedRows(s.store, MODEL, Array.from({ length: 3 }, (_, i) => ({
      id: `row-${i}`, data: { reviewer: false, title: `${i}` },
    })));
    const reads: string[] = [];
    let snapshots = 0;
    const memberships: MembershipReader = { ...s.identity,
      findMembership: async (team, user) => { reads.push(user); return s.identity.findMembership(team, user); },
      findMembershipsSnapshot: async (team, users) => { snapshots++; return s.identity.findMembershipsSnapshot(team, users); },
    };
    assert.equal((await queryRecords({ ...s.input, memberships })).records.length, 3);
    assert.equal(reads.filter(user => user === 'reviewer').length, typeof by !== 'string' && 'roleSubject' in by ? 1 : 0);
    assert.equal(snapshots, 0);
  }
});

test('nullable and false row decisions return no rows, while empty and malformed user values refuse', async () => {
  for (const value of [null, { id: 'ordinary' }, { id: 'missing' }]) {
    const s = await setup();
    await seedRows(s.store, MODEL, [{ id: 'row', data: { reviewer: value, title: 'hidden' } }]);
    assert.deepEqual((await queryRecords(s.input)).records, []);
  }
  for (const value of ['', false, { id: '' }, { id: 'reviewer', extra: true }]) {
    const s = await setup();
    await seedRows(s.store, MODEL, [{ id: 'row', data: { reviewer: value, title: 'hidden' } }]);
    await assert.rejects(queryRecords(s.input));
  }
  const s = await setup();
  assert.deepEqual((await queryRecords(s.input)).records, []);
});

test('multi-subject query refuses a legacy reader before generated code', async () => {
  const s = await setup();
  await seedRows(s.store, MODEL, [{ id: 'row', data: { reviewer: { id: 'reviewer' }, title: 'hidden' } }]);
  let predicates = 0;
  await assert.rejects(queryRecords({ ...s.input,
    memberships: { findMembership: s.identity.findMembership },
    predicate: () => { predicates++; return true; },
  }), refuses);
  assert.equal(predicates, 0);
});

test('incomplete, reordered, foreign and malformed producer snapshots refuse before generated code', async () => {
  const corruptions: Array<(snapshot: MembershipSnapshot) => MembershipSnapshot> = [
    snapshot => ({ ...snapshot, entries: snapshot.entries.slice(1) }),
    snapshot => ({ ...snapshot, entries: [...snapshot.entries].reverse() }),
    snapshot => ({ ...snapshot, team_id: 'other-team' }),
    snapshot => ({ ...snapshot, entries: snapshot.entries.map(entry => entry.membership === null ? entry :
      { ...entry, membership: { ...entry.membership, status: 'unknown' as 'active' } }) }),
  ];
  for (const corrupt of corruptions) {
    const s = await setup();
    await seedRows(s.store, MODEL, [{ id: 'row', data: { reviewer: { id: 'reviewer' }, title: 'hidden' } }]);
    let predicates = 0;
    await assert.rejects(queryRecords({ ...s.input, memberships: { ...s.identity,
      findMembershipsSnapshot: async (team, users) => corrupt(await s.identity.findMembershipsSnapshot(team, users)),
    }, predicate: () => { predicates++; return true; } }), refuses);
    assert.equal(predicates, 0);
  }
});

test('equal-clock role metadata, role order, owner and status drift refuse coherent discovery', async () => {
  for (const change of ['grant-metadata', 'grant-order', 'owner', 'status'] as const) {
    const s = await setup();
    await seedRows(s.store, MODEL, [{ id: 'row', data: { reviewer: { id: 'reviewer' }, title: 'hidden' } }]);
    let predicates = 0;
    let changed = false;
    const memberships: MembershipReader = { ...s.identity,
      findMembershipsSnapshot: async (team, users) => {
        if (!changed) {
          changed = true;
          if (change === 'grant-metadata') await s.identity.setMembershipRoles(s.reviewer.membership_id,
            [roleGrant(ROLE, 'different-grantor'), roleGrant('Acme.other')]);
          if (change === 'grant-order') await s.identity.setMembershipRoles(s.reviewer.membership_id,
            [roleGrant('Acme.other'), roleGrant()]);
          if (change === 'owner') await s.identity.setMembershipOwner(s.reviewer.membership_id, true);
          if (change === 'status') await s.identity.removeMembership(s.reviewer.membership_id);
        }
        return s.identity.findMembershipsSnapshot(team, users);
      },
    };
    await assert.rejects(queryRecords({ ...s.input, memberships,
      predicate: () => { predicates++; return true; } }), refuses);
    assert.equal(predicates, 0, change);
  }
});

test('99 complete authority facts succeed; 100 refuse without partial callbacks or result', async () => {
  for (const count of [98, 99]) {
    const s = await setup();
    const rows = [];
    for (let i = 0; i < count; i++) {
      const user = `subject-${i}`;
      await s.identity.createMembership({ team_id: TEAM, user_id: user, is_owner: false, roles: [roleGrant()] });
      rows.push({ id: `row-${i}`, data: { reviewer: { id: user }, title: `${i}` } });
    }
    await seedRows(s.store, MODEL, rows);
    let callbacks = 0;
    const pending = queryRecords({ ...s.input, predicate: () => { callbacks++; return true; } });
    if (count === 98) {
      assert.equal((await pending).records.length, 98);
      assert.equal(callbacks, 98);
    } else {
      await assert.rejects(pending, refuses);
      assert.equal(callbacks, 0);
    }
  }
});

test('revocation in a generated predicate fails after one invocation without rerunning caller code', async () => {
  const s = await setup();
  await seedRows(s.store, MODEL, [{ id: 'row', data: { reviewer: { id: 'reviewer' }, title: 'visible' } }]);
  let callbacks = 0;
  await assert.rejects(queryRecords({ ...s.input, predicate: async record => {
    callbacks++;
    assert.deepEqual(record.data, { title: 'visible' });
    await s.identity.removeMembership(s.reviewer.membership_id);
    return true;
  } }), refuses);
  assert.equal(callbacks, 1);
});

test('revocation in a page transform fails after one transform without rerunning generated code', async () => {
  const s = await setup();
  await seedRows(s.store, MODEL, [{ id: 'row', data: { reviewer: { id: 'reviewer' }, title: 'visible' } }]);
  let predicates = 0;
  let transforms = 0;
  await assert.rejects(queryRecordsPage({ ...s.input,
    generatedPredicate: () => { predicates++; return true; },
  }, async page => {
    transforms++;
    assert.deepEqual(page.records[0]!.data, { title: 'visible' });
    await s.identity.removeMembership(s.reviewer.membership_id);
    return page;
  }), refuses);
  assert.equal(predicates, 1);
  assert.equal(transforms, 1);
});

test('saved projection selects current subject authority and preserves original saved values', async () => {
  const s = await setup([grant(subject(), ['title', 'reviewer', 'settings'])]);
  const saved = makeRow({ id: 'row', data: { reviewer: { id: 'ordinary' }, title: 'original',
    settings: { label: 'original-label', token: 'original-secret' } } });
  const current = makeRow({ id: 'row', version: 2, data: { reviewer: { id: 'reviewer' }, title: 'current',
    settings: { label: 'current-label', token: 'current-secret' } } });
  const context = { actorUserId: 'caller', teamId: TEAM, membership: s.caller, memberships: s.identity };
  const result = await projectSavedRecordForViewer({ policy: s.table.get(MODEL), context,
    current, saved, originalSecretFields: ['settings.token'] });
  assert.deepEqual(result!.data, { title: 'original', reviewer: { id: 'ordinary' },
    settings: { label: 'original-label' } });
  assert.equal(result!.version, 1);
  assert.equal(await projectSavedRecordForViewer({ policy: s.table.get(MODEL), context,
    current: saved, saved: current, originalSecretFields: [] }), null);
  assert.equal(saved.data['title'], 'original');
  assert.equal(current.data['title'], 'current');
});

test('caller full facts must agree with the subject snapshot before any disclosure', async () => {
  const s = await setup([grant({ and: [{ role: 'Acme.reader' }, subject()] }, ['title'])]);
  await seedRows(s.store, MODEL, [{ id: 'row', data: { reviewer: { id: 'reviewer' }, title: 'hidden' } }]);
  let callbacks = 0;
  const memberships: MembershipReader = { ...s.identity,
    findMembershipsSnapshot: async (team, users) => {
      await s.identity.setMembershipOwner(s.caller.membership_id, true);
      return s.identity.findMembershipsSnapshot(team, users);
    },
  };
  await assert.rejects(queryRecords({ ...s.input, memberships,
    predicate: () => { callbacks++; return true; } }), refuses);
  assert.equal(callbacks, 0);
});

test('storage revision drift in generated code refuses without a partial result or callback rerun', async () => {
  const s = await setup();
  await seedRows(s.store, MODEL, [{ id: 'row', data: { reviewer: { id: 'reviewer' }, title: 'visible' } }]);
  let callbacks = 0;
  await assert.rejects(queryRecords({ ...s.input, predicate: async () => {
    callbacks++;
    await seedRows(s.store, MODEL, [{ id: 'new', data: { reviewer: null, title: 'new' } }]);
    return true;
  } }), (error: unknown) => error instanceof StateError && error.code === 'conflict');
  assert.equal(callbacks, 1);
});
