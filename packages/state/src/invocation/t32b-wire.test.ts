/**
 * T32b-wire invoke tests (colocated): the canonical invoke() path WIRED to
 * the checkpoint fence — commit-time revalidation between execute and commit
 * at BOTH commit sites (success + rejected receipt), executor guards/readings
 * threading, trusted-kind parity, and the rejected-receipt fence rule.
 *
 * Every proof below drives REAL invoke() execution (admit -> execute ->
 * revalidate -> commit); the T32b-fence mechanism tests pinned the isolated
 * revalidate function. Memory store + local membership double; durable
 * substrates ride in t32b-wire-durable.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { invoke, type ExecuteHandler, type ExecutionEffects } from './invoke.js';
import type { AdmittedCall } from './admission.js';
import type {
  InterimOperationDef,
  OperationRegistry,
} from './registry.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import { StateError } from '../errors.js';
import type { QueryPredicate } from '@canlang/contracts';
import { buildModelTable, crudDefs, crudExecute } from '../mutation/index.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  asOperationId,
  captureStateError,
  createMemoryIdentityStore,
  makeBatch,
  makeDef,
  makeEnvelope,
  makeIdentity,
  seedMember,
  seedRow,
  updateRow,
  uuidv7,
} from '../../test/invocation/fixtures.js';
import type { SeededMember } from '../../test/invocation/fixtures.js';
import { field, modelDef } from '../../test/mutation/fixtures.js';

const APP = 'acme-app';
const OPERATION = 'Acme.approve';
const MODEL = asModel('Acme.Gadget');

async function setup() {
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  return { store, memberships, team: alice.team, alice };
}

function identityFor(member: SeededMember) {
  return makeIdentity({ membership: member.membership, email: member.user.email });
}

function registryFor(def: InterimOperationDef): OperationRegistry {
  return new Map([[def.name as string, def]]);
}

function bareEffects(overrides: Partial<ExecutionEffects> = {}): ExecutionEffects {
  return {
    writes: [],
    history: [],
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
    resolvedDefaults: {},
    result: null,
    ...overrides,
  };
}

function receiptIdentity(teamId: string, userId: string, operationId: string) {
  return {
    app: APP,
    owner: teamId,
    principal: userId,
    operation: asOperation(OPERATION),
    operationId: asOperationId(operationId),
  };
}

describe('T32b-wire invoke success path', () => {
  it('commits through the wired fence when quiet (revision + live by pass)', async () => {
    const { store, memberships, team, alice } = await setup();
    const def = makeDef();
    const operationId = uuidv7(FIXED_NOW);
    let guardRan = false;
    const execute: ExecuteHandler = async () =>
      bareEffects({
        guards: [
          {
            name: 'stock.available',
            evaluate: () => {
              guardRan = true;
              return true;
            },
          },
        ],
        result: { approved: true },
      });
    const outcome = await invoke({
      registry: registryFor(def),
      envelope: makeEnvelope(OPERATION, operationId, {}),
      identity: identityFor(alice),
      app: APP,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
    });
    assert.equal(outcome.status, 'committed');
    assert.deepEqual(outcome.result, { approved: true });
    assert.equal(guardRan, true);
    assert.equal(await store.readRevision(), 1);
    const receipt = await store.readReceipt(receiptIdentity(team.team_id, alice.user.user_id, operationId));
    assert.ok(receipt);
    assert.equal(receipt.outcome.status, 'committed');
  });

  it('retries an intervening change, then commits (revision fence wired)', async () => {
    const { store, memberships, alice } = await setup();
    const def = makeDef();
    const operationId = uuidv7(FIXED_NOW);
    let calls = 0;
    const execute: ExecuteHandler = async () => {
      calls += 1;
      if (calls === 1) {
        // Intervening write lands between admission and commit.
        await store.commit(makeBatch((await store.readRevision()) as number, {}));
      }
      return bareEffects({ result: { approved: true } });
    };
    const outcome = await invoke({
      registry: registryFor(def),
      envelope: makeEnvelope(OPERATION, operationId, {}),
      identity: identityFor(alice),
      app: APP,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
    });
    assert.equal(outcome.status, 'committed');
    assert.equal(calls, 2);
    // Intervening commit + the retried commit: two revisions.
    assert.equal(await store.readRevision(), 2);
  });

  it('voids with forbidden on mid-flight revocation; nothing commits', async () => {
    const { store, memberships, team, alice } = await setup();
    const def = makeDef();
    const operationId = uuidv7(FIXED_NOW);
    const revisionBefore = await store.readRevision();
    const execute: ExecuteHandler = async () => {
      // Revocation lands between checkpoint and commit WITHOUT moving the
      // state revision: only the live authority check can void this.
      await memberships.removeMembership(alice.membership.membership_id);
      return bareEffects({ result: { approved: true } });
    };
    const error = await captureStateError(
      invoke({
        registry: registryFor(def),
        envelope: makeEnvelope(OPERATION, operationId, {}),
        identity: identityFor(alice),
        app: APP,
        source: 'test',
        store,
        memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute,
      }),
    );
    assert.equal(error.code, 'forbidden');
    assert.match(error.message, /revoked/);
    // Void leaves no trace: no receipt, revision unmoved, so a later retry
    // with a new identity re-admits cleanly.
    assert.equal(await store.readRevision(), revisionBefore);
    assert.equal(
      await store.readReceipt(receiptIdentity(team.team_id, alice.user.user_id, operationId)),
      null,
    );
  });

  it('voids with forbidden naming the flipped guard; nothing commits', async () => {
    const { store, memberships, team, alice } = await setup();
    const def = makeDef();
    const operationId = uuidv7(FIXED_NOW);
    const execute: ExecuteHandler = async () =>
      bareEffects({
        guards: [
          { name: 'stock.available', evaluate: () => true },
          { name: 'allowance.bounded', evaluate: async () => false },
        ],
        result: { approved: true },
      });
    const error = await captureStateError(
      invoke({
        registry: registryFor(def),
        envelope: makeEnvelope(OPERATION, operationId, {}),
        identity: identityFor(alice),
        app: APP,
        source: 'test',
        store,
        memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute,
      }),
    );
    assert.equal(error.code, 'forbidden');
    assert.match(error.message, /"allowance\.bounded"/);
    assert.equal(await store.readRevision(), 0);
    assert.equal(
      await store.readReceipt(receiptIdentity(team.team_id, alice.user.user_id, operationId)),
      null,
    );
  });

  it('refuses executor-offered eventual readings through the wired path', async () => {
    const { store, memberships, alice } = await setup();
    const def = makeDef();
    const execute: ExecuteHandler = async () =>
      bareEffects({ readings: [{ eventual: true, result: { records: [] } }] });
    const error = await captureStateError(
      invoke({
        registry: registryFor(def),
        envelope: makeEnvelope(OPERATION, uuidv7(FIXED_NOW), {}),
        identity: identityFor(alice),
        app: APP,
        source: 'test',
        store,
        memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /eventual/);
    assert.equal(await store.readRevision(), 0);
  });

  it('trusted kind skips permission revalidation but keeps the revision assertion', async () => {
    const { store, memberships, team } = await setup();
    // A `by` no caller could satisfy, plus a failing guard: trusted
    // authority is the verified source, exactly like admission.
    const def = makeDef({ by: 'owner' });
    const identity = makeIdentity({ actor: null, teamId: team.team_id, membership: null });
    const execute: ExecuteHandler = async () =>
      bareEffects({ guards: [{ name: 'never', evaluate: () => false }] });
    const base = {
      registry: registryFor(def),
      identity,
      app: APP,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      kind: 'trusted' as const,
      trustedSource: 'test-source',
      execute,
    };
    const committed = await invoke({
      ...base,
      envelope: makeEnvelope(OPERATION, uuidv7(FIXED_NOW, 1), {}),
    });
    assert.equal(committed.status, 'committed');

    // But the revision assertion is unconditional: intervene once and the
    // trusted commit retries like any other.
    let calls = 0;
    const racy: ExecuteHandler = async () => {
      calls += 1;
      if (calls === 1) {
        await store.commit(makeBatch((await store.readRevision()) as number, {}));
      }
      return bareEffects({ result: 'retry-ok' });
    };
    const retried = await invoke({
      ...base,
      envelope: makeEnvelope(OPERATION, uuidv7(FIXED_NOW, 2), {}),
      execute: racy,
    });
    assert.equal(retried.status, 'committed');
    assert.equal(calls, 2);
  });
});

describe('T32b-wire membership-free gates (no false void)', () => {
  it('public serves team-scoped callers with zero membership rows', async () => {
    const { store } = createTestMemoryStorage();
    // Zero membership rows: the store is deliberately unseeded.
    const memberships = createMemoryIdentityStore();
    const def = makeDef({ by: 'public' });
    const identity = makeIdentity({ userId: 'user-outsider', teamId: 'team-a', membership: null });
    const operationId = uuidv7(FIXED_NOW);
    const outcome = await invoke({
      registry: registryFor(def),
      envelope: makeEnvelope(OPERATION, operationId, {}),
      identity,
      app: APP,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute: async () => bareEffects({ result: { restocked: 'pub' } }),
    });
    assert.equal(outcome.status, 'committed');
    const receipt = await store.readReceipt({
      app: APP,
      owner: 'team-a',
      principal: 'user-outsider',
      operation: asOperation(OPERATION),
      operationId: asOperationId(operationId),
    });
    assert.ok(receipt);
    assert.equal(receipt.outcome.status, 'committed');
  });

  it('authenticated serves team-scoped actors with zero membership rows', async () => {
    const { store } = createTestMemoryStorage();
    const memberships = createMemoryIdentityStore();
    const def = makeDef({ by: 'authenticated' });
    const identity = makeIdentity({ userId: 'user-outsider', teamId: 'team-a', membership: null });
    const outcome = await invoke({
      registry: registryFor(def),
      envelope: makeEnvelope(OPERATION, uuidv7(FIXED_NOW), {}),
      identity,
      app: APP,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute: async () => bareEffects({ result: 'ok' }),
    });
    assert.equal(outcome.status, 'committed');
  });

  it('members still voids when the membership never existed team-side (admit denies first)', async () => {
    const { store } = createTestMemoryStorage();
    const memberships = createMemoryIdentityStore();
    const def = makeDef({ by: 'members' });
    const identity = makeIdentity({ userId: 'user-outsider', teamId: 'team-a', membership: null });
    // Sanity on the other side of the projection: membership-gated ops
    // never reach the commit for membership-less callers — admission
    // denies, so the wire's faithful identity has nothing to false-void.
    const error = await captureStateError(
      invoke({
        registry: registryFor(def),
        envelope: makeEnvelope(OPERATION, uuidv7(FIXED_NOW), {}),
        identity,
        app: APP,
        source: 'test',
        store,
        memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute: async () => bareEffects(),
      }),
    );
    assert.equal(error.code, 'forbidden');
    assert.equal(await store.readRevision(), 0);
  });
});

describe('T32b-wire rejected-receipt fence rule', () => {
  it('a rejection raced with revocation still records; original error preserved; no domain writes', async () => {
    const { store, memberships, team, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1', data: { title: 't' } });
    const def = makeDef();
    const operationId = uuidv7(FIXED_NOW);
    const revisionBefore = await store.readRevision();
    const execute: ExecuteHandler = async () => {
      await memberships.removeMembership(alice.membership.membership_id);
      throw new StateError('validation', 'Bad ref.');
    };
    const error = await captureStateError(
      invoke({
        registry: registryFor(def),
        envelope: makeEnvelope(OPERATION, operationId, {}),
        identity: identityFor(alice),
        app: APP,
        source: 'test',
        store,
        memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute,
      }),
    );
    // The ORIGINAL business rejection surfaces — never the fence's forbidden.
    assert.equal(error.code, 'validation');
    assert.equal(error.message, 'Bad ref.');
    // The rejection records (receipt-only commit: exactly one revision), and
    // replays observe it deterministically.
    assert.equal(await store.readRevision(), (revisionBefore as number) + 1);
    const receipt = await store.readReceipt(
      receiptIdentity(team.team_id, alice.user.user_id, operationId),
    );
    assert.ok(receipt);
    assert.deepEqual(receipt.outcome, { status: 'rejected', code: 'validation', message: 'Bad ref.' });
    assert.equal(receipt.committedRevision, (revisionBefore as number) + 1);
    // No domain writes committed: the seeded row is untouched.
    const row = await store.load(MODEL, asId('rec-1'));
    assert.ok(row);
    assert.equal(row.version, 1);
    assert.deepEqual(row.data, { title: 't' });
  });

  it('a rejection raced with an intervening change retries, then records', async () => {
    const { store, memberships, alice } = await setup();
    const def = makeDef();
    const operationId = uuidv7(FIXED_NOW);
    let calls = 0;
    const execute: ExecuteHandler = async () => {
      calls += 1;
      if (calls === 1) {
        await store.commit(makeBatch((await store.readRevision()) as number, {}));
      }
      throw new StateError('rule_failed', 'Precondition failed.');
    };
    const error = await captureStateError(
      invoke({
        registry: registryFor(def),
        envelope: makeEnvelope(OPERATION, operationId, {}),
        identity: identityFor(alice),
        app: APP,
        source: 'test',
        store,
        memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute,
      }),
    );
    assert.equal(error.code, 'rule_failed');
    assert.equal(calls, 2);
    // Intervening commit + the receipt-only commit.
    assert.equal(await store.readRevision(), 2);
    const receipt = await store.readReceipt(
      receiptIdentity(alice.team.team_id, alice.user.user_id, operationId),
    );
    assert.ok(receipt);
    assert.equal(receipt.outcome.status, 'rejected');
  });
});

describe('T32b-wire CRUD paths (real pipeline + executors)', () => {
  function crudWorld(by: 'members' | 'owner' = 'members', when?: QueryPredicate) {
    const table = buildModelTable([modelDef(MODEL as string, { fields: { title: field() } })]);
    const triple = crudDefs(MODEL, when === undefined ? { by } : { by, when });
    return { table, triple };
  }

  async function crudSetup(by: 'members' | 'owner' = 'members', when?: QueryPredicate) {
    const { store, memberships, alice } = await setup();
    const { table, triple } = crudWorld(by, when);
    const registry: OperationRegistry = new Map([
      [triple.create.name as string, triple.create],
      [triple.update.name as string, triple.update],
      [triple.remove.name as string, triple.remove],
    ]);
    const execute = crudExecute({ table, model: MODEL, store });
    return { store, memberships, alice, registry, execute };
  }

  it('CRUD create + update commit through the wired fence (no executor guards)', async () => {
    const { store, memberships, alice, registry, execute } = await crudSetup();
    const base = {
      registry,
      identity: identityFor(alice),
      app: APP,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
    };
    const created = await invoke({
      ...base,
      envelope: makeEnvelope(`${MODEL as string}.create`, uuidv7(FIXED_NOW, 1), {
        id: 'g-1',
        data: { title: 'wired' },
      }),
    });
    assert.equal(created.status, 'committed');
    const updated = await invoke({
      ...base,
      envelope: makeEnvelope(`${MODEL as string}.update`, uuidv7(FIXED_NOW, 2), {
        ref: { id: 'g-1', version: '1' },
        patch: { title: 'wired-again' },
      }),
    });
    assert.equal(updated.status, 'committed');
    const row = await store.load(MODEL, asId('g-1'));
    assert.ok(row);
    assert.equal(row.version, 2);
    assert.deepEqual(row.data, { title: 'wired-again' });
  });

  it('a when-carrying update raced with an intervening change conflicts (no silent commit)', async () => {
    const { store, memberships, alice, registry, execute } = await crudSetup('members', {
      op: 'eq',
      field: 'title',
      value: 'v1',
    });
    // Seed through the real path so versions/fences line up.
    await invoke({
      registry,
      envelope: makeEnvelope(`${MODEL as string}.create`, uuidv7(FIXED_NOW, 1), {
        id: 'g-race',
        data: { title: 'v1' },
      }),
      identity: identityFor(alice),
      app: APP,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
    });
    let calls = 0;
    const racy: ExecuteHandler = async (call: AdmittedCall) => {
      calls += 1;
      if (calls === 1) {
        // Intervening write to the when-read row lands after admission.
        const current = await store.load(MODEL, asId('g-race'));
        assert.ok(current);
        await updateRow(store, MODEL, current);
      }
      return execute(call);
    };
    const error = await captureStateError(
      invoke({
        registry,
        envelope: makeEnvelope(`${MODEL as string}.update`, uuidv7(FIXED_NOW, 2), {
          ref: { id: 'g-race', version: '1' },
          patch: {},
        }),
        identity: identityFor(alice),
        app: APP,
        source: 'test',
        store,
        memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute: racy,
      }),
    );
    // The wired fence voids the first attempt on the success path (moved
    // checkpoint — the empty patch keeps `when` passing, so execution
    // succeeds and only the fence refuses); the retry re-checks the
    // submitted version against the bumped row and conflicts instead of
    // overwriting. Either way the `when` row predicate — evaluated over row
    // state — is fence-protected via the revision assertion, with no guard
    // conversion needed.
    assert.equal(error.code, 'conflict');
    assert.match(error.message, /Stale record version/);
    assert.equal(calls, 1);
    const row = await store.load(MODEL, asId('g-race'));
    assert.ok(row);
    assert.equal(row.version, 2);
    assert.deepEqual(row.data, { title: 'v1' });
  });
});
