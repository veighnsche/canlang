/**
 * Lane 03 S3 role/`by` tests (worker B): actor predicates, declared-role
 * grants, the explicit-subject form, no-team behavior, and/or/not
 * combinators, and resolver-error propagation (DESIGN §4, §13 `hasRole`).
 *
 * Aligned to worker A's actuals: `evaluateBy`/`hasRole` take plain facts
 * objects; `members`/`owner` evaluate the caller-supplied membership
 * snapshot while declared-role forms re-resolve through the reader.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { byDependsOnRow, evaluateBy, hasRole } from '../../src/policy/roles.js';
import { buildPolicyTable, matchGrants, withPolicyRow, type InterimModelPolicy } from '../../src/policy/grants.js';
import type { ByPredicate, MembershipReader } from '../../src/policy/roles.js';
import type { CanonicalModelDescriptor, Membership, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore as createIdentityMemoryStore } from '@canlang/identity/testing';
import { StateError } from '../../src/errors.js';
import {
  captureFailure,
  asModel,
  createMemoryIdentityStore,
  FIXED_NOW,
  makeRow,
  seedMember,
} from './fixtures.js';

const REVIEWER = 'Acme.reviewer';

async function seedTeam() {
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const team = alice.team;
  const owner = await seedMember(memberships, { teamId: team.team_id, isOwner: true });
  const carol = await seedMember(memberships, {
    teamId: team.team_id,
    isOwner: false,
    roles: [REVIEWER],
  });
  const dave = await seedMember(memberships, {
    teamId: team.team_id,
    isOwner: false,
    status: 'removed',
  });
  const outsider = await seedMember(memberships, { isOwner: false });
  return { memberships, team, alice, owner, carol, dave, outsider };
}

function byFacts(
  actorUserId: string | null,
  teamId: string | null,
  membership: Membership | null,
  memberships: MembershipReader,
) {
  return { actorUserId, teamId, membership, memberships };
}

function roleFacts(
  actorUserId: string | null,
  teamId: string | null,
  memberships: MembershipReader,
) {
  return { actorUserId, teamId, memberships };
}

function throwingReader(boom: Error): MembershipReader {
  return {
    findMembership: async () => {
      throw boom;
    },
  };
}

describe('evaluateBy', () => {
  it('public is always true, even with no actor or team', async () => {
    const { memberships, team, alice } = await seedTeam();
    assert.equal(
      await evaluateBy(
        'public',
        byFacts(alice.user.user_id, team.team_id, alice.membership, memberships),
        ),
      true,
    );
    assert.equal(await evaluateBy('public', byFacts(null, null, null, memberships)), true);
  });

  it('authenticated follows actor presence', async () => {
    const { memberships, team, alice } = await seedTeam();
    assert.equal(
      await evaluateBy(
        'authenticated',
        byFacts(alice.user.user_id, team.team_id, alice.membership, memberships),
      ),
      true,
    );
    assert.equal(
      await evaluateBy('authenticated', byFacts(null, team.team_id, null, memberships)),
      false,
    );
  });

  it('members requires an active membership snapshot', async () => {
    const { memberships, team, alice, dave, outsider } = await seedTeam();
    const by: ByPredicate = 'members';
    assert.equal(
      await evaluateBy(by, byFacts(alice.user.user_id, team.team_id, alice.membership, memberships)),
      true,
    );
    assert.equal(
      await evaluateBy(by, byFacts(dave.user.user_id, team.team_id, dave.membership, memberships)),
      false,
      'removed membership',
    );
    assert.equal(
      await evaluateBy(by, byFacts(outsider.user.user_id, team.team_id, null, memberships)),
      false,
      'no membership',
    );
    assert.equal(
      await evaluateBy(by, byFacts(null, team.team_id, null, memberships)),
      false,
      'no actor',
    );
  });

  it('members trusts the caller-supplied snapshot (freshness is the caller contract)', async () => {
    const { memberships, team, alice } = await seedTeam();
    await memberships.removeMembership(alice.membership.membership_id);
    // evaluateBy is pure over its inputs: a stale active snapshot still
    // admits here. Freshness is enforced end-to-end because admit re-reads
    // the current membership before calling (see admission revocation test).
    assert.equal(
      await evaluateBy(
        'members',
        byFacts(alice.user.user_id, team.team_id, alice.membership, memberships),
      ),
      true,
    );
  });

  it('owner requires the owner flag; a declared grant alone is not enough', async () => {
    const { memberships, team, owner, carol } = await seedTeam();
    const by: ByPredicate = 'owner';
    assert.equal(
      await evaluateBy(by, byFacts(owner.user.user_id, team.team_id, owner.membership, memberships)),
      true,
    );
    assert.equal(
      await evaluateBy(by, byFacts(carol.user.user_id, team.team_id, carol.membership, memberships)),
      false,
    );
  });

  it('declared role re-resolves through the reader; owner does not imply it', async () => {
    const { memberships, team, alice, owner, carol } = await seedTeam();
    const by: ByPredicate = { role: REVIEWER };
    assert.equal(
      await evaluateBy(by, byFacts(carol.user.user_id, team.team_id, null, memberships)),
      true,
    );
    assert.equal(
      await evaluateBy(by, byFacts(alice.user.user_id, team.team_id, null, memberships)),
      false,
    );
    assert.equal(
      await evaluateBy(by, byFacts(owner.user.user_id, team.team_id, null, memberships)),
      false,
    );
    assert.equal(
      await evaluateBy(
        by,
        byFacts(carol.user.user_id, team.team_id, { ...carol.membership, roles: [] }, memberships),
      ),
      true,
      'a stale grant-less snapshot cannot revoke the live grant',
    );
  });

  it('supports the explicit-subject form for another person', async () => {
    const { memberships, team, alice, owner, carol, dave } = await seedTeam();
    const caller = (person: string): ByPredicate => ({ roleSubject: { role: REVIEWER, person } });
    const aliceFacts = (membership: Membership | null) =>
      byFacts(alice.user.user_id, team.team_id, membership, memberships);
    assert.equal(await evaluateBy(caller(carol.user.user_id), aliceFacts(null)), true);
    assert.equal(await evaluateBy(caller(dave.user.user_id), aliceFacts(null)), false);
    assert.equal(await evaluateBy(caller('user-ghost'), aliceFacts(null)), false);
    assert.equal(await evaluateBy(caller(owner.user.user_id), aliceFacts(null)), false);
  });

  it('team predicates are false without a team; public/authenticated still apply', async () => {
    const { memberships, alice, carol } = await seedTeam();
    const ctx = byFacts(alice.user.user_id, null, null, memberships);
    assert.equal(await evaluateBy('members', ctx), false);
    assert.equal(await evaluateBy('owner', ctx), false);
    assert.equal(await evaluateBy({ role: REVIEWER }, ctx), false);
    assert.equal(
      await evaluateBy({ roleSubject: { role: REVIEWER, person: carol.user.user_id } }, ctx),
      false,
    );
    assert.equal(await evaluateBy('public', ctx), true);
    assert.equal(await evaluateBy('authenticated', ctx), true);
  });

  it('evaluates and/or/not combinators', async () => {
    const { memberships, team, alice, owner, carol, outsider } = await seedTeam();
    const facts = (userId: string, membership: Membership | null) =>
      byFacts(userId, team.team_id, membership, memberships);
    const aliceFacts = facts(alice.user.user_id, alice.membership);
    const ownerFacts = facts(owner.user.user_id, owner.membership);
    const carolFacts = facts(carol.user.user_id, carol.membership);
    const outsiderFacts = facts(outsider.user.user_id, null);

    const both: ByPredicate = { and: ['members', { role: REVIEWER }] };
    assert.equal(await evaluateBy(both, carolFacts), true);
    assert.equal(await evaluateBy(both, aliceFacts), false);

    const either: ByPredicate = { or: ['owner', { role: REVIEWER }] };
    assert.equal(await evaluateBy(either, carolFacts), true);
    assert.equal(await evaluateBy(either, ownerFacts), true);
    assert.equal(await evaluateBy(either, aliceFacts), false);

    const notMember: ByPredicate = { not: 'members' };
    assert.equal(await evaluateBy(notMember, outsiderFacts), true);
    assert.equal(await evaluateBy(notMember, aliceFacts), false);

    const nested: ByPredicate = { and: [{ or: ['owner', { role: REVIEWER }] }, { not: 'owner' }] };
    assert.equal(await evaluateBy(nested, carolFacts), true);
    assert.equal(await evaluateBy(nested, ownerFacts), false);
  });

  it('propagates reader errors from role checks instead of resolving false', async () => {
    const { team, alice, carol } = await seedTeam();
    const boom = new Error('resolver boom');
    const throwing = throwingReader(boom);
    const ctx = byFacts(alice.user.user_id, team.team_id, null, throwing);
    assert.strictEqual(await captureFailure(evaluateBy({ role: REVIEWER }, ctx)), boom);
    assert.strictEqual(
      await captureFailure(
        evaluateBy({ roleSubject: { role: REVIEWER, person: carol.user.user_id } }, ctx),
      ),
      boom,
    );
  });

  it('resolves members/owner from the snapshot without touching the reader', async () => {
    const { team, alice } = await seedTeam();
    const throwing = throwingReader(new Error('must not be called'));
    assert.equal(
      await evaluateBy(
        'members',
        byFacts(alice.user.user_id, team.team_id, alice.membership, throwing),
      ),
      true,
    );
    assert.equal(
      await evaluateBy('members', byFacts(alice.user.user_id, team.team_id, null, throwing)),
      false,
    );
  });
});

describe('hasRole', () => {
  it('checks the caller when no subject is given', async () => {
    const { memberships, team, alice, owner, carol } = await seedTeam();
    assert.equal(
      await hasRole(roleFacts(carol.user.user_id, team.team_id, memberships), REVIEWER),
      true,
    );
    assert.equal(
      await hasRole(roleFacts(alice.user.user_id, team.team_id, memberships), REVIEWER),
      false,
    );
    assert.equal(
      await hasRole(roleFacts(owner.user.user_id, team.team_id, memberships), REVIEWER),
      false,
      'owner without the explicit grant',
    );
  });

  it('checks another person with the explicit subject argument', async () => {
    const { memberships, team, alice, owner, carol, dave } = await seedTeam();
    const caller = roleFacts(alice.user.user_id, team.team_id, memberships);
    assert.equal(await hasRole(caller, REVIEWER, carol.user.user_id), true, 'active subject');
    assert.equal(await hasRole(caller, REVIEWER, dave.user.user_id), false, 'removed subject');
    assert.equal(await hasRole(caller, REVIEWER, 'user-ghost'), false, 'unknown subject');
    assert.equal(
      await hasRole(caller, REVIEWER, owner.user.user_id),
      false,
      'owner without the grant',
    );
  });

  it('ignores the caller for subject checks and the team-less context denies', async () => {
    const { memberships, team, outsider, carol } = await seedTeam();
    assert.equal(
      await hasRole(
        roleFacts(outsider.user.user_id, team.team_id, memberships),
        REVIEWER,
        carol.user.user_id,
      ),
      true,
      'subject grant holds even when the caller has no membership',
    );
    assert.equal(
      await hasRole(roleFacts(carol.user.user_id, null, memberships), REVIEWER, carol.user.user_id),
      false,
      'no-team subject check is false',
    );
  });

  it('propagates reader errors instead of resolving false', async () => {
    const { team, alice, carol } = await seedTeam();
    const boom = new Error('resolver boom');
    const throwing = throwingReader(boom);
    const ctx = roleFacts(alice.user.user_id, team.team_id, throwing);
    assert.strictEqual(await captureFailure(hasRole(ctx, REVIEWER)), boom);
    assert.strictEqual(
      await captureFailure(hasRole(ctx, REVIEWER, carol.user.user_id)),
      boom,
    );
  });
});

const SUBJECT_MODEL = asModel('Acme.Review');
const rowSubject = (field = 'reviewer'): ByPredicate => ({
  roleSubject: { role: REVIEWER, person: { model: SUBJECT_MODEL, field } },
});
const subjectDeclaration = (valueType = 'user'): CanonicalModelDescriptor => ({
  name: SUBJECT_MODEL,
  deleteMode: 'remove',
  fields: { reviewer: { required: valueType === 'user', serverOnly: false, valueType } },
});
const subjectPolicy = (by = rowSubject(), secretFields: readonly string[] = []): InterimModelPolicy => ({
  model: SUBJECT_MODEL, secretFields, grants: [{ by, fields: ['label'] }],
});
function checkedSubjectPolicy(valueType = 'user', by = rowSubject()): InterimModelPolicy {
  return buildPolicyTable([subjectPolicy(by)], [subjectDeclaration(valueType)]).get(SUBJECT_MODEL)!;
}

describe('row role subjects', () => {
  it('classifies nested subjects while preserving static and caller predicates', () => {
    for (const by of ['members', 'owner', 'authenticated', 'public', { role: REVIEWER },
      { roleSubject: { role: REVIEWER, person: 'static-user' } }] as ByPredicate[]) {
      assert.equal(byDependsOnRow(by), false);
    }
    for (const by of [rowSubject(), { not: rowSubject() }, { or: ['public', rowSubject()] },
      { and: ['members', { not: rowSubject() }] }] as ByPredicate[]) {
      assert.equal(byDependsOnRow(by), true);
    }
  });

  it('requires the exact owning singular canonical user declaration, including beneath lazy gates', () => {
    const malformed = [
      rowSubject(''), rowSubject('reviewer.id'), rowSubject('createdBy'), rowSubject('parent'),
      { roleSubject: { role: REVIEWER, person: { model: asModel('Other.Review'), field: 'reviewer' } } },
      { roleSubject: { role: REVIEWER, person: { field: 'reviewer' } } },
      { roleSubject: { role: REVIEWER, person: { model: SUBJECT_MODEL, field: 'reviewer', extra: true } } },
    ] as ByPredicate[];
    for (const by of malformed) {
      assert.throws(() => buildPolicyTable([subjectPolicy(by)], [subjectDeclaration()]), /Invalid/);
    }
    for (const declarations of [[], [{ ...subjectDeclaration(), name: asModel('Other.Review') }],
      [{ ...subjectDeclaration(), fields: {} }], [subjectDeclaration('text')],
      [subjectDeclaration('user[]')], [subjectDeclaration('user[]?')],
      [{ ...subjectDeclaration(), fields: { reviewer: { required: true, serverOnly: false,
        valueType: 'user', array: { required: true } } } }],
      [{ ...subjectDeclaration(), fields: { reviewer: { required: true, serverOnly: false,
        valueType: 'user', nullable: true } } }], [subjectDeclaration(), subjectDeclaration()]]) {
      assert.throws(() => buildPolicyTable([subjectPolicy({ or: ['public', rowSubject()] })], declarations),
        /canonical singular user/);
    }
    assert.throws(() => buildPolicyTable([subjectPolicy(rowSubject(), ['reviewer'])], [subjectDeclaration()]), /secret/);
    assert.throws(() => buildPolicyTable([subjectPolicy(rowSubject(), ['reviewer.id'])], [subjectDeclaration()]), /secret/);
    let getters = 0;
    const accessorField = Object.defineProperty({ required: true, serverOnly: false }, 'valueType', {
      enumerable: true, get: () => { getters++; return 'user'; },
    });
    assert.throws(() => buildPolicyTable([subjectPolicy()], [{ ...subjectDeclaration(),
      fields: { reviewer: accessorField } }]), /own data/);
    const accessorSelector = Object.defineProperty({ model: SUBJECT_MODEL }, 'field', {
      enumerable: true, get: () => { getters++; return 'reviewer'; },
    });
    assert.throws(() => buildPolicyTable([subjectPolicy({ roleSubject: { role: REVIEWER,
      person: accessorSelector as { model: typeof SUBJECT_MODEL; field: string } } })], [subjectDeclaration()]), /own.*data/);
    assert.equal(getters, 0);
    for (const type of ['user', 'user?']) assert.ok(checkedSubjectPolicy(type));
    // The old single-argument static policy API remains valid.
    assert.ok(buildPolicyTable([subjectPolicy({ roleSubject: { role: REVIEWER, person: 'static-user' } })]));
  });

  it('uses the selected row user, never substitutes the actor, and directly matches grants per row', async () => {
    const { memberships, team, alice, carol, dave, owner } = await seedTeam();
    const policy = checkedSubjectPolicy();
    const ctx = byFacts(alice.user.user_id, team.team_id, alice.membership, memberships);
    const row = (id: string) => makeRow({ data: { reviewer: { id }, label: 'review' } });
    assert.equal(await evaluateBy(rowSubject(), withPolicyRow(policy, ctx, row(carol.user.user_id))), true);
    assert.equal(await evaluateBy(rowSubject(), withPolicyRow(policy, ctx, row(dave.user.user_id))), false);
    assert.equal(await evaluateBy(rowSubject(), withPolicyRow(policy, ctx, row(owner.user.user_id))), false);
    assert.equal(await evaluateBy(rowSubject(), withPolicyRow(policy, ctx, row('ghost-user'))), false);
    await assert.rejects(matchGrants(policy, ctx, row(carol.user.user_id)),
      (error: unknown) => error instanceof StateError && error.code === 'forbidden');
    assert.equal((await matchGrants(policy, ctx, row(alice.user.user_id))).length, 0);
    // Preserve the same caller + different subject join using Identity's actual
    // coherent snapshot producer; the singular-only fixture cannot authorize it.
    const identity = createIdentityMemoryStore({ clock: createFrozenClock(FIXED_NOW) });
    const coherentCaller = await identity.createMembership({ team_id: team.team_id,
      user_id: alice.user.user_id, is_owner: false, roles: alice.membership.roles });
    await identity.createMembership({ team_id: team.team_id,
      user_id: carol.user.user_id, is_owner: false, roles: carol.membership.roles });
    assert.equal((await matchGrants(policy,
      byFacts(alice.user.user_id, team.team_id, coherentCaller, identity), row(carol.user.user_id))).length, 1);
    assert.equal(await evaluateBy({ role: REVIEWER }, withPolicyRow(policy, ctx, row(carol.user.user_id))), false);
    assert.equal(await evaluateBy({ roleSubject: { role: REVIEWER, person: carol.user.user_id } }, ctx), true);
    assert.equal(await evaluateBy(rowSubject(), withPolicyRow(policy,
      byFacts(null, team.team_id, null, memberships), row(carol.user.user_id))), true);
    assert.equal(await evaluateBy(rowSubject(), withPolicyRow(policy,
      byFacts(carol.user.user_id, null, null, memberships), row(carol.user.user_id))), false);
  });

  it('keeps AND/OR lazy and errors beneath NOT; missing or mismatched bindings cannot grant', async () => {
    let calls = 0;
    const reader: MembershipReader = { findMembership: async () => { calls++; return null; } };
    const ctx = byFacts(null, 'team', null, reader);
    assert.equal(await evaluateBy({ and: ['authenticated', rowSubject()] }, ctx), false);
    assert.equal(await evaluateBy({ or: ['public', rowSubject()] }, ctx), true);
    await assert.rejects(evaluateBy({ not: rowSubject() }, ctx), /validated owning/);
    const policy = checkedSubjectPolicy();
    const bound = withPolicyRow(policy, ctx, makeRow({ data: { reviewer: { id: 'person' } } }));
    const other: ByPredicate = { roleSubject: { role: REVIEWER,
      person: { model: asModel('Other.Review'), field: 'reviewer' } } };
    await assert.rejects(evaluateBy(other, bound), /validated owning/);
    await assert.rejects(evaluateBy(rowSubject(), withPolicyRow(subjectPolicy(), bound, makeRow())), /validated owning/);
    assert.equal(calls, 0);
    const boom = new Error('subject reader failed');
    await assert.rejects(evaluateBy(rowSubject(), withPolicyRow(policy,
      byFacts(null, 'team', null, throwingReader(boom)), makeRow({ data: { reviewer: { id: 'person' } } }))),
      (error: unknown) => error === boom);
  });

  it('allows nullable null as absence and rejects malformed/required absence before any lookup or getter', async () => {
    let calls = 0;
    let getters = 0;
    const ctx = byFacts('actor', 'team', null, { findMembership: async () => { calls++; return null; } });
    const nullable = checkedSubjectPolicy('user?');
    const empty = withPolicyRow(nullable, ctx, makeRow({ data: { reviewer: null } }));
    assert.equal(await evaluateBy(rowSubject(), empty), false);
    assert.equal(await evaluateBy({ not: rowSubject() }, empty), true);
    const getterId = Object.defineProperty({}, 'id', { enumerable: true, get: () => { getters++; return 'person'; } });
    const getterField = Object.defineProperty({}, 'reviewer', { enumerable: true, get: () => { getters++; return { id: 'person' }; } });
    const getterData = Object.defineProperty(makeRow(), 'data', { get: () => { getters++; return { reviewer: { id: 'person' } }; } });
    const malformed = [undefined, null, '', 'person', 1, false, [], {}, { id: '' }, { id: 4 },
      { kind: 'user', id: 'person' }, { kind: 'file', id: 'person' }, { id: 'person', version: 1 },
      Object.create({ id: 'person' }), getterId];
    const policy = checkedSubjectPolicy();
    const rows = [makeRow(), makeRow({ data: Object.create({ reviewer: { id: 'person' } }) }),
      makeRow({ data: getterField }), getterData,
      ...malformed.map((reviewer) => makeRow({ data: { reviewer } }))];
    for (const row of rows) {
      await assert.rejects(evaluateBy({ not: rowSubject() }, withPolicyRow(policy, ctx, row)), /Invalid row role subject/);
    }
    await assert.rejects(evaluateBy(rowSubject(), withPolicyRow(nullable, ctx, makeRow())), /own data/);
    // Data must be an own object property, never an inherited row envelope member.
    const inheritedRow = Object.create(makeRow({ data: { reviewer: { id: 'person' } } })) as StoredRow;
    await assert.rejects(evaluateBy(rowSubject(), withPolicyRow(policy, ctx, inheritedRow)), /own data/);
    assert.equal(getters, 0);
    assert.equal(calls, 0);
  });

  it('retains frozen policy field types after caller mutation', async () => {
    const declaration = subjectDeclaration('user?');
    const policy = buildPolicyTable([subjectPolicy()], [declaration]).get(SUBJECT_MODEL)!;
    (declaration.fields.reviewer as { valueType: string }).valueType = 'text';
    const ctx = byFacts(null, null, null, throwingReader(new Error('no lookup')));
    assert.equal(await evaluateBy(rowSubject(), withPolicyRow(policy, ctx,
      makeRow({ data: { reviewer: null } }))), false);
    await assert.rejects(evaluateBy(rowSubject('undeclared'), withPolicyRow(policy, ctx, makeRow())), /validated owning/);
  });
});
