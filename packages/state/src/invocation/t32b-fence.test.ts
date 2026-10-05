/**
 * T32b checkpoint-fence tests (colocated): adopted Alternative A —
 * checkpoint enrollment at admission, commit-time revalidation
 * (revision + permission + revocation), the narrower L291 revocation
 * scope, transitive fresh scopes, and the T28-A same-owner
 * imported-parent enrollment. Memory store + local membership double;
 * durable-substrate fence proofs stay owed (see the T32b report).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  admit,
  enrollImportedParentRead,
  openFenceScope,
  openTransitiveScope,
  receiptIdentityFor,
  requireAuthorizingRead,
  revalidateCommitForFence,
} from './admission.js';
import { buildContext } from './context.js';
import type { InvocationContext } from '../../../contracts/src/state.js';
import { createMemoryStorage } from '../storage/memory.js';
import { FenceConflictError } from '../storage/port.js';
import type { MembershipReader } from '../policy/roles.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  asRevision,
  captureStateError,
  createMemoryIdentityStore,
  makeBatch,
  makeDef,
  makeIdentity,
  makeReceipt,
  makeRow,
  seedMember,
  seedReceipt,
  seedRow,
  updateRow,
  uuidv7,
} from '../../test/invocation/fixtures.js';

const APP = 'acme-app';
const OPERATION = 'Acme.approve';
const MODEL = asModel('Acme.Expense');
const PARENT_MODEL = asModel('Acme.Portfolio');

async function setup() {
  const store = createMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  return { store, memberships, team: alice.team, alice };
}

function ctxFor(
  userId: string | null,
  teamId: string,
  operationId: string,
  kind: 'user' | 'trusted' = 'user',
  trustedSource?: string,
): InvocationContext {
  return buildContext({
    identity: makeIdentity({
      actor:
        userId === null
          ? null
          : { user_id: userId, email: `${userId}@example.test`, email_verified: true },
      teamId,
      membership: null,
    }),
    app: APP,
    operation: asOperation(OPERATION),
    operationId,
    source: 'test',
    kind,
    ...(trustedSource === undefined ? {} : { trustedSource }),
    now: FIXED_NOW,
  });
}

function recordDef() {
  return makeDef({
    inputs: {
      expense: { type: 'record', model: MODEL, versioned: true, required: true },
    },
  });
}

describe('T32b checkpoint enrollment at admission', () => {
  it('enrolls membership + record reads at one owner checkpoint', async () => {
    const { store, memberships, team, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1', data: { title: 't' } });
    const ctx = ctxFor(alice.user.user_id, team.team_id, uuidv7(FIXED_NOW));
    const admission = await admit({
      def: recordDef(),
      inputs: { expense: { id: 'rec-1', version: '1' } },
      context: ctx,
      store,
      memberships,
    });

    assert.equal(admission.replay, null);
    const checkpoint = admission.checkpoint;
    assert.ok(checkpoint, 'admission carries a checkpoint');
    assert.equal(checkpoint.revision, admission.revision);
    assert.equal(checkpoint.owner, team.team_id);
    assert.deepEqual(checkpoint.dependencies, [
      { kind: 'membership', teamId: team.team_id, userId: alice.user.user_id },
      { kind: 'record', model: MODEL, id: 'rec-1', version: 1 },
    ]);
  });

  it('enrolls imported-parent linkage in the SAME scope (adopted T28-A)', async () => {
    const { store, memberships, team, alice } = await setup();
    await seedRow(store, PARENT_MODEL, { id: 'port-1' });
    const child = {
      ...makeRow({ id: 'rec-1', data: { title: 't' } }),
      parent: { model: PARENT_MODEL, id: asId('port-1') },
    };
    const revision = await store.readRevision();
    await store.commit(makeBatch(revision as number, { writes: [{ kind: 'insert', model: MODEL, row: child }] }));
    const ctx = ctxFor(alice.user.user_id, team.team_id, uuidv7(FIXED_NOW));
    const admission = await admit({
      def: recordDef(),
      inputs: { expense: { id: 'rec-1', version: '1' } },
      context: ctx,
      store,
      memberships,
    });

    const checkpoint = admission.checkpoint;
    assert.ok(checkpoint);
    // Same owner, same revision as the caller's own reads: no cross-owner
    // fence, no second scope — the imported-parent read joins the one
    // owner checkpoint.
    assert.equal(checkpoint.owner, team.team_id);
    assert.equal(checkpoint.revision, admission.revision);
    assert.ok(
      checkpoint.dependencies.some(
        (dep) => dep.kind === 'imported-parent' && dep.model === PARENT_MODEL && dep.id === 'port-1',
      ),
      `expected an imported-parent dep, got ${JSON.stringify(checkpoint.dependencies)}`,
    );
  });

  it('replays carry an (unenrolled) checkpoint snapshot', async () => {
    const { store, memberships, team, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    const def = recordDef();
    const inputs = { expense: { id: 'rec-1', version: '1' } };
    const ctx = ctxFor(alice.user.user_id, team.team_id, uuidv7(FIXED_NOW));
    const first = await admit({ def, inputs, context: ctx, store, memberships });
    const identity = receiptIdentityFor(ctx);
    await seedReceipt(
      store,
      makeReceipt({
        app: identity.app,
        owner: identity.owner,
        principal: identity.principal,
        operation: identity.operation,
        operationId: identity.operationId,
        inputHash: first.inputHash,
      }),
    );
    const second = await admit({ def, inputs, context: ctx, store, memberships });
    assert.ok(second.replay, 'stored receipt replays');
    assert.ok(second.checkpoint, 'replay carries a checkpoint snapshot');
    assert.deepEqual(second.checkpoint.dependencies, []);
  });
});

describe('T32b commit-time revalidation', () => {
  it('passes on a quiet store and the live reader agrees', async () => {
    const { store, memberships, team, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    const def = recordDef();
    const ctx = ctxFor(alice.user.user_id, team.team_id, uuidv7(FIXED_NOW));
    const admission = await admit({
      def,
      inputs: { expense: { id: 'rec-1', version: '1' } },
      context: ctx,
      store,
      memberships,
    });
    assert.ok(admission.checkpoint);
    let guardRan = false;
    await revalidateCommitForFence({
      checkpoint: admission.checkpoint,
      by: def.by,
      guards: [{ name: 'stock.available', evaluate: () => { guardRan = true; return true; } }],
      actorUserId: alice.user.user_id,
      teamId: team.team_id,
      kind: ctx.kind,
      store,
      memberships,
    });
    assert.equal(guardRan, true);
  });

  it('fails with conflict when a read dependency changed (stale revision)', async () => {
    const { store, memberships, team, alice } = await setup();
    const row = await seedRow(store, MODEL, { id: 'rec-1' });
    const def = recordDef();
    const ctx = ctxFor(alice.user.user_id, team.team_id, uuidv7(FIXED_NOW));
    const admission = await admit({
      def,
      inputs: { expense: { id: 'rec-1', version: '1' } },
      context: ctx,
      store,
      memberships,
    });
    assert.ok(admission.checkpoint);
    // Intervening change to a read dependency lands between checkpoint
    // and commit.
    await updateRow(store, MODEL, row);
    const error = await captureStateError(
      revalidateCommitForFence({
        checkpoint: admission.checkpoint,
        by: def.by,
        guards: [],
        actorUserId: alice.user.user_id,
        teamId: team.team_id,
        kind: ctx.kind,
        store,
        memberships,
      }),
    );
    assert.equal(error.code, 'conflict');
    assert.match(error.message, /enrolled at revision 1, now at 2/);
    assert.match(error.message, /2 enrolled read\(s\)/);
    // Both layers agree: the storage fence would refuse this commit too.
    const fence = await store
      .commit(makeBatch(admission.revision as number, {}))
      .then(
        () => null,
        (commitError: unknown) => commitError,
      );
    assert.ok(fence instanceof FenceConflictError, 'store fence agrees: stale commit refused');
  });

  it('voids with forbidden when membership is revoked mid-flight (narrower L291)', async () => {
    const { store, memberships, team, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    const def = recordDef();
    const ctx = ctxFor(alice.user.user_id, team.team_id, uuidv7(FIXED_NOW));
    const admission = await admit({
      def,
      inputs: { expense: { id: 'rec-1', version: '1' } },
      context: ctx,
      store,
      memberships,
    });
    assert.ok(admission.checkpoint);
    // Revocation lands between checkpoint and commit WITHOUT moving the
    // state revision (authority state is separate): the revision
    // assertion passes, and the live revocation check must void.
    await memberships.removeMembership(alice.membership.membership_id);
    const error = await captureStateError(
      revalidateCommitForFence({
        checkpoint: admission.checkpoint,
        by: def.by,
        guards: [],
        actorUserId: alice.user.user_id,
        teamId: team.team_id,
        kind: ctx.kind,
        store,
        memberships,
      }),
    );
    assert.equal(error.code, 'forbidden');
    assert.match(error.message, /revoked/);
  });

  it('voids with forbidden when permission flips but membership stays (live reader wins)', async () => {
    const { store, memberships, team, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    const def = makeDef({ by: 'owner', inputs: recordDef().inputs });
    const ctx = ctxFor(alice.user.user_id, team.team_id, uuidv7(FIXED_NOW));
    // Admission observes a live owner; the post-admission reader observes
    // the same row with ownership stripped (role change, no removal).
    let stripped = false;
    const flipping: MembershipReader = {
      findMembership: async (teamId, userId) => {
        const found = await memberships.findMembership(teamId, userId);
        if (found === null || !stripped) return found;
        return { ...found, is_owner: false };
      },
    };
    // Seed ownership through the underlying double by re-seeding: alice
    // is not an owner, so admit through a reader that reports ownership.
    const owning: MembershipReader = {
      findMembership: async (teamId, userId) => {
        const found = await memberships.findMembership(teamId, userId);
        return found === null ? null : { ...found, is_owner: true };
      },
    };
    const admission = await admit({
      def,
      inputs: { expense: { id: 'rec-1', version: '1' } },
      context: ctx,
      store,
      memberships: owning,
    });
    assert.ok(admission.checkpoint);
    stripped = true;
    const error = await captureStateError(
      revalidateCommitForFence({
        checkpoint: admission.checkpoint,
        by: def.by,
        guards: [],
        actorUserId: alice.user.user_id,
        teamId: team.team_id,
        kind: ctx.kind,
        store,
        memberships: flipping,
      }),
    );
    assert.equal(error.code, 'forbidden');
    assert.match(error.message, /Permission no longer holds/);
  });

  it('voids with forbidden naming the guard that flipped', async () => {
    const { store, memberships, team, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    const def = recordDef();
    const ctx = ctxFor(alice.user.user_id, team.team_id, uuidv7(FIXED_NOW));
    const admission = await admit({
      def,
      inputs: { expense: { id: 'rec-1', version: '1' } },
      context: ctx,
      store,
      memberships,
    });
    assert.ok(admission.checkpoint);
    const error = await captureStateError(
      revalidateCommitForFence({
        checkpoint: admission.checkpoint,
        by: def.by,
        guards: [
          { name: 'stock.available', evaluate: () => true },
          { name: 'allowance.bounded', evaluate: async () => false },
        ],
        actorUserId: alice.user.user_id,
        teamId: team.team_id,
        kind: ctx.kind,
        store,
        memberships,
      }),
    );
    assert.equal(error.code, 'forbidden');
    assert.match(error.message, /"allowance\.bounded"/);
  });

  it('trusted calls skip permission revalidation but keep the revision assertion', async () => {
    const { store, memberships, team } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    const def = makeDef({ by: 'owner', inputs: recordDef().inputs });
    const ctx = ctxFor(null, team.team_id, uuidv7(FIXED_NOW), 'trusted', 'test-source');
    const admission = await admit({
      def,
      inputs: { expense: { id: 'rec-1', version: '1' } },
      context: ctx,
      store,
      memberships,
    });
    assert.ok(admission.checkpoint);
    // A `by` that no caller could satisfy still revalidates: trusted
    // authority is the verified source, exactly like admission.
    await revalidateCommitForFence({
      checkpoint: admission.checkpoint,
      by: def.by,
      guards: [{ name: 'never', evaluate: () => false }],
      actorUserId: null,
      teamId: team.team_id,
      kind: ctx.kind,
      store,
      memberships,
    });
    // But the revision assertion is unconditional: move the store and the
    // trusted commit conflicts like any other.
    const row = await store.load(MODEL, asId('rec-1'));
    assert.ok(row);
    await updateRow(store, MODEL, row);
    const error = await captureStateError(
      revalidateCommitForFence({
        checkpoint: admission.checkpoint,
        by: def.by,
        guards: [],
        actorUserId: null,
        teamId: team.team_id,
        kind: ctx.kind,
        store,
        memberships,
      }),
    );
    assert.equal(error.code, 'conflict');
  });

  it('refuses eventual readings as authorization evidence', async () => {
    const { store } = await setup();
    const revision = await store.readRevision();
    const error = await captureStateError(
      revalidateCommitForFence({
        checkpoint: { revision, owner: 'team-a', dependencies: [] },
        by: 'public',
        guards: [],
        actorUserId: null,
        teamId: null,
        kind: 'user',
        store,
        memberships: { findMembership: async () => null },
        readings: [{ eventual: true, result: { records: [], revision } }],
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /eventual/);
  });

  it('requireAuthorizingRead passes plain readings and refuses eventual ones', () => {
    requireAuthorizingRead({ records: [], revision: 1 }, 'test');
    requireAuthorizingRead(null, 'test');
    assert.throws(() => requireAuthorizingRead({ eventual: true }, 'test'), /eventual/);
  });
});

describe('T32b fence scopes', () => {
  it('dedupes repeated enrollments and freezes snapshots', () => {
    const scope = openFenceScope(asRevision(3), 'team-a');
    scope.enroll({ kind: 'membership', teamId: 'team-a', userId: 'user-1' });
    scope.enroll({ kind: 'membership', teamId: 'team-a', userId: 'user-1' });
    scope.enroll({ kind: 'query', model: MODEL, authority: 'viewer' });
    assert.equal(scope.dependencies.length, 2);
    const frozen = scope.snapshot();
    scope.enroll({ kind: 'query', model: MODEL, authority: 'owner' });
    assert.equal(frozen.dependencies.length, 2);
    assert.equal(scope.dependencies.length, 3);
    assert.equal(frozen.revision, 3);
    assert.equal(frozen.owner, 'team-a');
  });

  it('enrollImportedParentRead enrolls in the caller scope (T28-A)', () => {
    const scope = openFenceScope(asRevision(7), 'team-a');
    enrollImportedParentRead(scope, { model: PARENT_MODEL, id: asId('port-1') });
    assert.deepEqual(scope.snapshot().dependencies, [
      { kind: 'imported-parent', model: PARENT_MODEL, id: 'port-1' },
    ]);
    assert.equal(scope.snapshot().revision, 7);
  });

  it('transitive scopes open fresh with zero inherited dependencies', async () => {
    const { store } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    const trigger = openFenceScope(asRevision(1), 'team-a');
    trigger.enroll({ kind: 'query', model: MODEL, authority: 'viewer' });
    // The trigger committed (revision moved); the transitive effect opens
    // its own scope at CURRENT state, inheriting nothing.
    const row = await store.load(MODEL, asId('rec-1'));
    assert.ok(row);
    await updateRow(store, MODEL, row);
    const transitive = await openTransitiveScope(store, 'team-a');
    assert.equal(transitive.revision, 2);
    assert.deepEqual(transitive.dependencies, []);
    assert.equal(trigger.dependencies.length, 1);
  });
});
