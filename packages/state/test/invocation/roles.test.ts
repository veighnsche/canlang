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
import { evaluateBy, hasRole } from '../../src/policy/roles.js';
import type { ByPredicate, MembershipReader } from '../../src/policy/roles.js';
import type { Membership } from '../../../contracts/src/identity.js';
import {
  captureFailure,
  createMemoryIdentityStore,
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
