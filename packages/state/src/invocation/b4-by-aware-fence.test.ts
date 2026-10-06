/**
 * B4-authority: by-aware commit-time revocation check, driven through
 * `invoke` (no suite exercised compound gates through invoke before).
 *
 * The mechanism's explicit revocation void ("actor+team present but no
 * live active membership") fires only for gates whose authority flows
 * from the caller's own membership row (`byRequiresCallerMembership`).
 * Gates that can authorize without caller membership — `or` with a
 * membership-free branch, `not`, subject-gated, `public`,
 * `authenticated` — commit without false-voiding; the live `evaluateBy`
 * re-check still voids genuinely lost permission for every gate.
 * Memory store + local membership double.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { invoke, type ExecuteHandler } from './invoke.js';
import { byRequiresCallerMembership, type ByPredicate } from '../policy/roles.js';
import { createMemoryStorage } from '../storage/memory.js';
import {
  FIXED_NOW,
  captureStateError,
  createMemoryIdentityStore,
  makeDef,
  makeEnvelope,
  makeIdentity,
  seedMember,
  uuidv7,
  type TestMembershipStore,
} from '../../test/invocation/fixtures.js';

const APP = 'acme-app';
const OPERATION = 'Acme.approve';

let opSeq = 9000;

function trivialExecute(): ExecuteHandler {
  return async () => ({
    writes: [],
    history: [],
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
    resolvedDefaults: {},
    result: 'ok',
  });
}

async function invokeWithBy(
  by: ByPredicate,
  identity: ReturnType<typeof makeIdentity>,
  memberships: TestMembershipStore,
  execute: ExecuteHandler = trivialExecute(),
) {
  const store = createMemoryStorage();
  const def = makeDef({ by, inputs: {} });
  const registry = new Map([[def.name, def]]);
  return invoke({
    registry,
    envelope: makeEnvelope(OPERATION, uuidv7(FIXED_NOW, (opSeq += 1)), {}),
    identity,
    app: APP,
    source: 'test',
    store,
    memberships,
    clock: { nowMs: () => FIXED_NOW },
    execute,
  });
}

describe('B4 by-aware explicit check: necessity truth table', () => {
  it('pins caller-membership necessity per predicate shape', () => {
    const cases: Array<[ByPredicate, boolean]> = [
      ['members', true],
      ['owner', true],
      [{ role: 'acme.steward' }, true],
      ['public', false],
      ['authenticated', false],
      [{ roleSubject: { role: 'acme.steward', person: 'user-dave' } }, false],
      [{ and: ['members', 'public'] }, true],
      [{ and: ['public', 'authenticated'] }, false],
      [{ or: ['members', 'owner'] }, true],
      [{ or: ['public', 'members'] }, false],
      [{ not: 'members' }, false],
      [{ not: { role: 'acme.steward' } }, false],
    ];
    for (const [by, expected] of cases) {
      assert.equal(byRequiresCallerMembership(by), expected, JSON.stringify(by));
    }
  });
});

describe('B4 compound gates through invoke: no false-void', () => {
  it('or with a membership-free branch commits for a row-less caller', async () => {
    const memberships = createMemoryIdentityStore();
    const seeded = await seedMember(memberships, { isOwner: false });
    const ghost = makeIdentity({
      userId: 'user-ghost',
      teamId: seeded.team.team_id,
      membership: null,
    });
    const result = await invokeWithBy({ or: ['public', 'members'] }, ghost, memberships);
    assert.equal(result.status, 'committed');
    assert.equal(result.result, 'ok');
  });

  it('not-members commits for a row-less caller', async () => {
    const memberships = createMemoryIdentityStore();
    const seeded = await seedMember(memberships, { isOwner: false });
    const ghost = makeIdentity({
      userId: 'user-ghost',
      teamId: seeded.team.team_id,
      membership: null,
    });
    const result = await invokeWithBy({ not: 'members' }, ghost, memberships);
    assert.equal(result.status, 'committed');
  });

  it('not-members still refuses actual members at admission', async () => {
    const memberships = createMemoryIdentityStore();
    const alice = await seedMember(memberships, { isOwner: false });
    const error = await captureStateError(
      invokeWithBy(
        { not: 'members' },
        makeIdentity({ membership: alice.membership }),
        memberships,
      ),
    );
    assert.equal(error.code, 'forbidden');
    assert.match(error.message, /not permitted for the caller/);
  });

  it('subject-gated commits for a row-less caller while the grant holds', async () => {
    const memberships = createMemoryIdentityStore();
    const dave = await seedMember(memberships, { isOwner: false, roles: ['acme.steward'] });
    const ghost = makeIdentity({
      userId: 'user-ghost',
      teamId: dave.team.team_id,
      membership: null,
    });
    const result = await invokeWithBy(
      { roleSubject: { role: 'acme.steward', person: dave.user.user_id } },
      ghost,
      memberships,
    );
    assert.equal(result.status, 'committed');
  });

  it('subject-gated voids when the subject grant lapses mid-flight', async () => {
    const memberships = createMemoryIdentityStore();
    const dave = await seedMember(memberships, { isOwner: false, roles: ['acme.steward'] });
    const ghost = makeIdentity({
      userId: 'user-ghost',
      teamId: dave.team.team_id,
      membership: null,
    });
    const execute: ExecuteHandler = async () => {
      await memberships.removeMembership(dave.membership.membership_id);
      return {
        writes: [],
        history: [],
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
        resolvedDefaults: {},
        result: 'ok',
      };
    };
    const error = await captureStateError(
      invokeWithBy(
        { roleSubject: { role: 'acme.steward', person: dave.user.user_id } },
        ghost,
        memberships,
        execute,
      ),
    );
    assert.equal(error.code, 'forbidden');
    assert.match(error.message, /Permission no longer holds at commit/);
  });
});

describe('B4 membership-necessary gates through invoke: revocation still voids', () => {
  it('or of member-only branches voids on mid-flight revocation', async () => {
    const memberships = createMemoryIdentityStore();
    const alice = await seedMember(memberships, { isOwner: false });
    const execute: ExecuteHandler = async () => {
      await memberships.removeMembership(alice.membership.membership_id);
      return {
        writes: [],
        history: [],
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
        resolvedDefaults: {},
        result: 'ok',
      };
    };
    const error = await captureStateError(
      invokeWithBy(
        { or: ['members', 'owner'] },
        makeIdentity({ membership: alice.membership }),
        memberships,
        execute,
      ),
    );
    assert.equal(error.code, 'forbidden');
    assert.match(error.message, /Authority revoked during the operation/);
  });

  it('plain members voids on mid-flight revocation', async () => {
    const memberships = createMemoryIdentityStore();
    const alice = await seedMember(memberships, { isOwner: false });
    const execute: ExecuteHandler = async () => {
      await memberships.removeMembership(alice.membership.membership_id);
      return {
        writes: [],
        history: [],
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
        resolvedDefaults: {},
        result: 'ok',
      };
    };
    const error = await captureStateError(
      invokeWithBy('members', makeIdentity({ membership: alice.membership }), memberships, execute),
    );
    assert.equal(error.code, 'forbidden');
    assert.match(error.message, /Authority revoked during the operation/);
  });
});

describe('B4 membership-free builtins through invoke: no false-void', () => {
  it('authenticated commits for a row-less caller', async () => {
    const memberships = createMemoryIdentityStore();
    const seeded = await seedMember(memberships, { isOwner: false });
    const ghost = makeIdentity({
      userId: 'user-ghost',
      teamId: seeded.team.team_id,
      membership: null,
    });
    const result = await invokeWithBy('authenticated', ghost, memberships);
    assert.equal(result.status, 'committed');
  });

  it('public commits for a row-less caller', async () => {
    const memberships = createMemoryIdentityStore();
    const seeded = await seedMember(memberships, { isOwner: false });
    const ghost = makeIdentity({
      userId: 'user-ghost',
      teamId: seeded.team.team_id,
      membership: null,
    });
    const result = await invokeWithBy('public', ghost, memberships);
    assert.equal(result.status, 'committed');
  });
});
