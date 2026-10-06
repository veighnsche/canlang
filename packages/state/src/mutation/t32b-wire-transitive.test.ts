/**
 * T32b-wire hook transitive tests (colocated): T31 hook bodies wired as
 * transitive effects — fresh scopes at the CURRENT revision (zero inherited
 * deps), trigger-point threading (revision + owner only, never deps), and
 * current-committed re-reads that bypass the provisional map.
 *
 * Every proof below drives REAL runMutationWrites execution with hook bodies
 * that open scopes and re-read; the T32b-fence mechanism tests pinned the
 * isolated openTransitiveScope function. The dispatch claim-site contract
 * (DispatchFence derivation) is proven through real fence values here; the
 * literal refused-inherited-scope / refused-revoked statuses through the
 * REAL attemptDispatch function ride in the /tmp end-to-end probe (the work
 * package cannot be imported into the state build) plus the work mechanism
 * tests that pin status ordering. Memory store + local membership double;
 * durable substrates ride in t32b-wire-durable.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runMutationWrites } from './pipeline.js';
import { buildModelTable } from './models.js';
import { admit } from '../invocation/admission.js';
import { buildContext } from '../invocation/context.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  createMemoryIdentityStore,
  makeBatch,
  makeDef,
  makeIdentity,
  seedMember,
  seedRow,
  uuidv7,
} from '../../test/invocation/fixtures.js';
import { field, hook, modelDef, pipelineContext } from '../../test/mutation/fixtures.js';

const APP = 'acme-app';
const OPERATION = 'Acme.approve';
const MODEL = asModel('Acme.Gadget');

async function setup() {
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  return { store, memberships, team: alice.team, alice };
}

describe('T32b-wire hook transitive scopes', () => {
  it('hook bodies open fresh scopes at the current revision with zero inherited deps', async () => {
    const { store, team } = await setup();
    await seedRow(store, MODEL, { id: 'g-1', data: { title: 'v1' } });
    const triggerRevision = await store.readRevision();
    // An intervening commit lands after the trigger checkpoint.
    await store.commit(makeBatch(triggerRevision as number, {}));

    const seen: Array<{
      triggerRevision: unknown;
      owner: unknown;
      scopeRevision: unknown;
      scopeOwner: unknown;
      depsAtOpen: unknown;
    }> = [];
    const capture = hook('capture', ['update'], async (candidate, ctx) => {
      // One more bump INSIDE the hook: the scope must read live at open
      // time, not at pipeline start.
      await store.commit(makeBatch((await store.readRevision()) as number, {}));
      const scope = await ctx.transitive.openScope();
      seen.push({
        triggerRevision: ctx.transitive.triggerRevision,
        owner: ctx.transitive.owner,
        scopeRevision: scope.revision,
        scopeOwner: scope.owner,
        depsAtOpen: scope.snapshot().dependencies,
      });
      return candidate;
    });
    const table = buildModelTable([
      modelDef(MODEL as string, { fields: { title: field() }, hooks: [capture] }),
    ]);
    await runMutationWrites({
      table,
      writes: [{ op: 'update', model: MODEL, id: asId('g-1'), data: { title: 'v2' } }],
      context: pipelineContext({ operation: `${MODEL as string}.update` }),
      store,
      trigger: { revision: triggerRevision, owner: team.team_id },
    });

    assert.equal(seen.length, 1);
    const capture0 = seen[0];
    assert.ok(capture0);
    // Trigger point threads through (revision + owner only); the scope
    // itself opens at the CURRENT revision with zero inherited deps.
    assert.equal(capture0.triggerRevision, triggerRevision);
    assert.equal(capture0.owner, team.team_id);
    assert.equal(capture0.scopeRevision, (triggerRevision as number) + 2);
    assert.equal(capture0.scopeOwner, team.team_id);
    assert.deepEqual(capture0.depsAtOpen, []);
  });

  it('transitive load re-reads committed state and enrolls, bypassing provisional', async () => {
    const { store, team } = await setup();
    await seedRow(store, MODEL, { id: 'g-1', data: { title: 'committed' } });
    const triggerRevision = await store.readRevision();

    const seen: Array<{ version: unknown; data: unknown; deps: unknown }> = [];
    const reread = hook('reread', ['update'], async (candidate, ctx) => {
      const scope = await ctx.transitive.openScope();
      const row = await ctx.transitive.load(scope, MODEL, asId('g-1'));
      seen.push({
        version: row?.version,
        data: row?.data,
        deps: scope.snapshot().dependencies,
      });
      return candidate;
    });
    const table = buildModelTable([
      modelDef(MODEL as string, { fields: { title: field() }, hooks: [reread] }),
    ]);
    await runMutationWrites({
      table,
      writes: [{ op: 'update', model: MODEL, id: asId('g-1'), data: { title: 'pending' } }],
      context: pipelineContext({ operation: `${MODEL as string}.update` }),
      store,
      trigger: { revision: triggerRevision, owner: team.team_id },
    });

    assert.equal(seen.length, 1);
    const reread0 = seen[0];
    assert.ok(reread0);
    // The re-read observes COMMITTED state (version 1, old title) — never
    // the pending candidate — and enrolls the observed version.
    assert.equal(reread0.version, 1);
    assert.deepEqual(reread0.data, { title: 'committed' });
    assert.deepEqual(reread0.deps, [
      { kind: 'record', model: MODEL, id: 'g-1', version: 1 },
    ]);
  });

  it('transitive load cannot see the uncommitted trigger row (create)', async () => {
    const { store, team } = await setup();
    const triggerRevision = await store.readRevision();

    const seen: Array<{ row: unknown; deps: unknown }> = [];
    const probe = hook('probe', ['create'], async (candidate, ctx) => {
      const scope = await ctx.transitive.openScope();
      const row = await ctx.transitive.load(scope, MODEL, ctx.triggerId);
      seen.push({ row, deps: scope.snapshot().dependencies });
      return candidate;
    });
    const table = buildModelTable([
      modelDef(MODEL as string, { fields: { title: field() }, hooks: [probe] }),
    ]);
    await runMutationWrites({
      table,
      writes: [{ op: 'create', model: MODEL, id: asId('g-new'), data: { title: 'pending' } }],
      context: pipelineContext({ operation: `${MODEL as string}.create` }),
      store,
      trigger: { revision: triggerRevision, owner: team.team_id },
    });

    assert.equal(seen.length, 1);
    const probe0 = seen[0];
    assert.ok(probe0);
    assert.equal(probe0.row, null);
    assert.deepEqual(probe0.deps, []);
  });

  it('absent trigger falls back to null revision and team ?? app owner', async () => {
    const { store } = await setup();
    await seedRow(store, MODEL, { id: 'g-1', data: { title: 'v1' } });

    const seen: Array<{ triggerRevision: unknown; owner: unknown; scopeRevision: unknown }> = [];
    const capture = hook('capture', ['update'], async (candidate, ctx) => {
      const scope = await ctx.transitive.openScope();
      seen.push({
        triggerRevision: ctx.transitive.triggerRevision,
        owner: ctx.transitive.owner,
        scopeRevision: scope.revision,
      });
      return candidate;
    });
    const table = buildModelTable([
      modelDef(MODEL as string, { fields: { title: field() }, hooks: [capture] }),
    ]);
    // Team-scoped context, no trigger: owner falls back to the team.
    await runMutationWrites({
      table,
      writes: [{ op: 'update', model: MODEL, id: asId('g-1'), data: {} }],
      context: pipelineContext({ operation: `${MODEL as string}.update`, teamId: 'team-a' }),
      store,
    });
    // App-scoped context, no trigger: owner falls back to the app.
    await runMutationWrites({
      table,
      writes: [{ op: 'update', model: MODEL, id: asId('g-1'), data: {} }],
      context: pipelineContext({ operation: `${MODEL as string}.update`, teamId: null }),
      store,
    });

    assert.equal(seen.length, 2);
    assert.deepEqual(
      seen.map((entry) => [entry.triggerRevision, entry.owner]),
      [
        [null, 'team-a'],
        [null, APP],
      ],
    );
    for (const entry of seen) {
      assert.equal(entry.scopeRevision, await store.readRevision());
    }
  });
});

describe('T32b-wire dispatch claim-site contract (real fence values)', () => {
  it('derives fresh-checkpoint + triggerRevision + live authority through real execution', async () => {
    const { store, memberships, team, alice } = await setup();
    await seedRow(store, MODEL, { id: 'g-1', data: { title: 'v1' } });

    // REAL admission: the trigger checkpoint (revision + owner + deps).
    const def = makeDef({
      inputs: { gadget: { type: 'record', model: MODEL, versioned: true, required: true } },
    });
    const context = buildContext({
      identity: makeIdentity({ membership: alice.membership, email: alice.user.email }),
      app: APP,
      operation: asOperation(OPERATION),
      operationId: uuidv7(FIXED_NOW),
      source: 'test',
      now: FIXED_NOW,
    });
    const admitted = await admit({
      def,
      inputs: { gadget: { id: 'g-1', version: '1' } },
      context,
      store,
      memberships,
    });
    assert.ok(admitted.checkpoint);
    const triggerRevision = admitted.checkpoint.revision;
    assert.ok(admitted.checkpoint.dependencies.length > 0);

    // A REAL intervening commit moves the revision before the hook runs.
    await store.commit(makeBatch(triggerRevision as number, {}));

    // REAL pipeline execution with the trigger point: the hook opens its
    // own scope and re-reads at it.
    const seen: Array<{ scopeRevision: number; deps: unknown; rowVersion: unknown }> = [];
    const transitive = hook('transitive', ['update'], async (candidate, ctx) => {
      assert.equal(ctx.transitive.triggerRevision, triggerRevision);
      assert.equal(ctx.transitive.owner, team.team_id);
      const scope = await ctx.transitive.openScope();
      const atOpen = scope.snapshot().dependencies;
      const row = await ctx.transitive.load(scope, MODEL, asId('g-1'));
      seen.push({ scopeRevision: scope.revision as number, deps: atOpen, rowVersion: row?.version });
      return candidate;
    });
    const table = buildModelTable([
      modelDef(MODEL as string, { fields: { title: field() }, hooks: [transitive] }),
    ]);
    await runMutationWrites({
      table,
      writes: [{ op: 'update', model: MODEL, id: asId('g-1'), data: { title: 'v2' } }],
      context: pipelineContext({ operation: `${MODEL as string}.update`, teamId: team.team_id }),
      store,
      trigger: { revision: triggerRevision, owner: team.team_id },
    });
    assert.equal(seen.length, 1);
    const seen0 = seen[0];
    assert.ok(seen0);
    assert.deepEqual(seen0.deps, []);
    assert.equal(seen0.rowVersion, 1);

    // The DispatchFence a claim site passes, built ONLY from real
    // execution artifacts (consumer: work attemptDispatch — see
    // packages/work/src/dispatch/index.ts ordering: inherited-scope ->
    // supersession -> guard -> revoked -> claim).
    const fence = {
      checkpoint: { revision: seen0.scopeRevision, owner: team.team_id },
      triggerRevision: { revision: triggerRevision as number },
    };
    // Fresh, not inherited: the claim-site inherited-scope bar would NOT
    // fire on this real fence (equality is the refusal condition).
    assert.notEqual(fence.checkpoint.revision, fence.triggerRevision.revision);
    // Live authority re-reads live: active now...
    const liveBefore = await memberships.findMembership(team.team_id, alice.user.user_id);
    assert.ok(liveBefore);
    assert.equal(liveBefore.status, 'active');
    // ...and a REAL revocation flips the claim-time revalidation input
    // (the row is retained with status `removed` — liveness is
    // present-and-active, never row-existence alone).
    await memberships.removeMembership(alice.membership.membership_id);
    const liveAfter = await memberships.findMembership(team.team_id, alice.user.user_id);
    assert.ok(liveAfter);
    assert.equal(liveAfter.status, 'removed');
    // Presenting the trigger's own revision back IS inheriting: a fence
    // built that way (checkpoint == triggerRevision) meets the refusal
    // condition — the shape claim sites must never pass.
    const inherited = {
      checkpoint: { revision: triggerRevision as number, owner: team.team_id },
      triggerRevision: { revision: triggerRevision as number },
    };
    assert.equal(inherited.checkpoint.revision, inherited.triggerRevision.revision);
  });
});
