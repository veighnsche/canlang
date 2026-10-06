/**
 * Lane 03 S3 admission tests (worker B): `by` enforcement, closed-input
 * validation, record-ref/version checks, receipt replay short-circuit, and
 * revocation — all against the memory store plus the local membership double.
 *
 * Aligned to worker A's actuals: `admit` takes `{def, inputs, context,
 * store, memberships}` and returns `AdmittedCall` (`recordRefs`, `inputHash`,
 * `revision`, `replay`); input defs are `{type:'record'|'scalar', ...}`.
 * S3 has no member/user input kind, so "unknown input member" is covered as
 * the closed-shape unknown-field case.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { admit, receiptIdentityFor } from '../../src/invocation/admission.js';
import { buildContext } from '../../src/invocation/context.js';
import type { InvocationContext } from '@canlang/contracts';
import { createMemoryStorage } from '../../src/storage/memory.js';
import {
  FIXED_NOW,
  MAX_OPERATION_ID_AGE_MS,
  asModel,
  asOperation,
  captureFailure,
  captureStateError,
  createMemoryIdentityStore,
  fieldPaths,
  makeDef,
  makeIdentity,
  makeReceipt,
  seedMember,
  seedReceipt,
  seedRow,
  updateRow,
  uuidv7,
} from './fixtures.js';

const APP = 'acme-app';
const OPERATION = 'Acme.approve';
const MODEL = asModel('Acme.Expense');

async function setup() {
  const store = createMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const outsider = await seedMember(memberships, { isOwner: false });
  return { store, memberships, team: alice.team, alice, outsider };
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
      title: { type: 'scalar', required: true },
    },
  });
}

describe('admit', () => {
  it('admits valid record + scalar inputs with refs, rows, revision, and hash', async () => {
    const { store, memberships, team, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1', data: { title: 't' } });
    const operationId = uuidv7(FIXED_NOW);
    const ctx = ctxFor(alice.user.user_id, team.team_id, operationId);
    const admission = await admit({
      def: recordDef(),
      inputs: { expense: { id: 'rec-1', version: '1' }, title: 'hello' },
      context: ctx,
      store,
      memberships,
    });

    assert.equal(admission.replay, null);
    assert.equal(admission.revision, 1);
    assert.ok(typeof admission.inputHash === 'string' && admission.inputHash.length > 0);
    assert.deepEqual(admission.context, ctx);
    assert.equal(admission.recordRefs.length, 1);
    const ref = admission.recordRefs[0];
    assert.ok(ref);
    assert.equal(ref.param, 'expense');
    assert.equal(ref.model, 'Acme.Expense');
    assert.equal(ref.id, 'rec-1');
    assert.equal(ref.expectedVersion, 1);
    assert.equal(ref.row.id, 'rec-1');
    assert.equal(ref.row.version, 1);
    assert.deepEqual(ref.row.data, { title: 't' });
  });

  it('rejects an outsider on a members-gated operation with forbidden', async () => {
    const { store, memberships, team, outsider } = await setup();
    const operationId = uuidv7(FIXED_NOW);
    const error = await captureStateError(
      admit({
        def: makeDef(),
        inputs: {},
        context: ctxFor(outsider.user.user_id, team.team_id, operationId),
        store,
        memberships,
      }),
    );
    assert.equal(error.code, 'forbidden');
  });

  it('rejects unknown closed-input members with validation and a fields path', async () => {
    const { store, memberships, team, alice } = await setup();
    const operationId = uuidv7(FIXED_NOW);
    const error = await captureStateError(
      admit({
        def: makeDef(),
        inputs: { bogus: 1 },
        context: ctxFor(alice.user.user_id, team.team_id, operationId),
        store,
        memberships,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.ok(fieldPaths(error).includes('/bogus'));
  });

  it('rejects a missing required input with validation and a fields path', async () => {
    const { store, memberships, team, alice } = await setup();
    const operationId = uuidv7(FIXED_NOW);
    const error = await captureStateError(
      admit({
        def: makeDef({ inputs: { title: { type: 'scalar', required: true } } }),
        inputs: {},
        context: ctxFor(alice.user.user_id, team.team_id, operationId),
        store,
        memberships,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.ok(fieldPaths(error).includes('/title'));
  });

  it('rejects malformed record refs with validation', async () => {
    const { store, memberships, team, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    const def = makeDef({
      inputs: { expense: { type: 'record', model: MODEL, versioned: true, required: true } },
    });
    const cases: ReadonlyArray<{ readonly name: string; readonly ref: unknown }> = [
      { name: 'missing id', ref: { version: '1' } },
      { name: 'bad version string', ref: { id: 'rec-1', version: 'abc' } },
      { name: 'non-integer version string', ref: { id: 'rec-1', version: '1.5' } },
      { name: 'numeric version (never a JSON number)', ref: { id: 'rec-1', version: 1 } },
      { name: 'missing version on a versioned input', ref: { id: 'rec-1' } },
    ];
    let seq = 0;
    for (const { name, ref } of cases) {
      seq += 1;
      const operationId = uuidv7(FIXED_NOW, seq);
      const error = await captureStateError(
        admit({
          def,
          inputs: { expense: ref },
          context: ctxFor(alice.user.user_id, team.team_id, operationId),
          store,
          memberships,
        }),
      );
      assert.equal(error.code, 'validation', name);
      assert.ok(
        fieldPaths(error).some((path) => path === '/expense' || path.startsWith('/expense/')),
        `${name}: fields path under /expense, got ${JSON.stringify(fieldPaths(error))}`,
      );
    }
  });

  it('maps a missing row and a wrong-model load to not_found', async () => {
    const { store, memberships, team, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    await seedRow(store, asModel('Acme.Other'), { id: 'rec-other' });
    const def = makeDef({
      inputs: { expense: { type: 'record', model: MODEL, versioned: true, required: true } },
    });

    const ghostId = uuidv7(FIXED_NOW);
    const ghost = await captureStateError(
      admit({
        def,
        inputs: { expense: { id: 'rec-ghost', version: '1' } },
        context: ctxFor(alice.user.user_id, team.team_id, ghostId),
        store,
        memberships,
      }),
    );
    assert.equal(ghost.code, 'not_found');

    const foreignId = uuidv7(FIXED_NOW, 1);
    const foreign = await captureStateError(
      admit({
        def,
        inputs: { expense: { id: 'rec-other', version: '1' } },
        context: ctxFor(alice.user.user_id, team.team_id, foreignId),
        store,
        memberships,
      }),
    );
    assert.equal(foreign.code, 'not_found');
  });

  it('maps stale (and ahead) submitted versions to conflict', async () => {
    const { store, memberships, team, alice } = await setup();
    const row = await seedRow(store, MODEL, { id: 'rec-1' });
    await updateRow(store, MODEL, row);
    const def = makeDef({
      inputs: { expense: { type: 'record', model: MODEL, versioned: true, required: true } },
    });

    const staleId = uuidv7(FIXED_NOW);
    const stale = await captureStateError(
      admit({
        def,
        inputs: { expense: { id: 'rec-1', version: '1' } },
        context: ctxFor(alice.user.user_id, team.team_id, staleId),
        store,
        memberships,
      }),
    );
    assert.equal(stale.code, 'conflict');

    const aheadId = uuidv7(FIXED_NOW, 1);
    const ahead = await captureStateError(
      admit({
        def,
        inputs: { expense: { id: 'rec-1', version: '3' } },
        context: ctxFor(alice.user.user_id, team.team_id, aheadId),
        store,
        memberships,
      }),
    );
    assert.equal(ahead.code, 'conflict');
  });

  it('rejects a new reference to an archived row with validation', async () => {
    const { store, memberships, team, alice } = await setup();
    const row = await seedRow(store, MODEL, { id: 'rec-1' });
    await updateRow(store, MODEL, row, { archivedAt: FIXED_NOW });
    const operationId = uuidv7(FIXED_NOW);
    const error = await captureStateError(
      admit({
        def: makeDef({
          inputs: { expense: { type: 'record', model: MODEL, versioned: true, required: true } },
        }),
        inputs: { expense: { id: 'rec-1', version: '2' } },
        context: ctxFor(alice.user.user_id, team.team_id, operationId),
        store,
        memberships,
      }),
    );
    assert.equal(error.code, 'validation');
  });

  it('replays a stored receipt without further checks', async () => {
    const { store, memberships, team, alice } = await setup();
    const row = await seedRow(store, MODEL, { id: 'rec-1' });
    const def = makeDef({
      inputs: { expense: { type: 'record', model: MODEL, versioned: true, required: true } },
    });
    const operationId = uuidv7(FIXED_NOW);
    const inputs = { expense: { id: 'rec-1', version: '1' } };
    const ctx = ctxFor(alice.user.user_id, team.team_id, operationId);
    const first = await admit({ def, inputs, context: ctx, store, memberships });
    assert.equal(first.replay, null);
    assert.deepEqual(receiptIdentityFor(ctx), {
      app: APP,
      owner: team.team_id,
      principal: alice.user.user_id,
      operation: OPERATION,
      operationId,
    });

    await seedReceipt(
      store,
      makeReceipt({
        ...receiptIdentityParts(ctx),
        inputHash: first.inputHash,
        outcome: { status: 'committed', result: { marker: 'saved-1' }, recordVersions: [] },
      }),
    );
    await updateRow(store, MODEL, row);

    const second = await admit({ def, inputs, context: ctx, store, memberships });
    assert.ok(second.replay, 'stored receipt replays instead of re-checking versions');
    assert.deepEqual(second.replay?.outcome, {
      status: 'committed',
      result: { marker: 'saved-1' },
      recordVersions: [],
    });
  });

  it('maps a receipt input-hash mismatch on a reused id to conflict', async () => {
    const { store, memberships, team, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    const def = recordDef();
    const operationId = uuidv7(FIXED_NOW);
    const ctx = ctxFor(alice.user.user_id, team.team_id, operationId);
    const first = await admit({
      def,
      inputs: { expense: { id: 'rec-1', version: '1' }, title: 'a' },
      context: ctx,
      store,
      memberships,
    });
    await seedReceipt(
      store,
      makeReceipt({ ...receiptIdentityParts(ctx), inputHash: first.inputHash }),
    );

    const error = await captureStateError(
      admit({
        def,
        inputs: { expense: { id: 'rec-1', version: '1' }, title: 'b' },
        context: ctx,
        store,
        memberships,
      }),
    );
    assert.equal(error.code, 'conflict');

    const freshId = uuidv7(FIXED_NOW, 1);
    const fresh = await admit({
      def,
      inputs: { expense: { id: 'rec-1', version: '1' }, title: 'b' },
      context: ctxFor(alice.user.user_id, team.team_id, freshId),
      store,
      memberships,
    });
    assert.equal(fresh.replay, null);
  });

  it('lets trusted kind skip a denied by', async () => {
    const { store, memberships, team } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    const operationId = uuidv7(FIXED_NOW);
    const admission = await admit({
      def: makeDef({
        by: { role: 'Acme.admin' },
        inputs: { expense: { type: 'record', model: MODEL, versioned: true, required: true } },
      }),
      inputs: { expense: { id: 'rec-1', version: '1' } },
      context: ctxFor(null, team.team_id, operationId, 'trusted', 'test-harness'),
      store,
      memberships,
    });
    assert.equal(admission.replay, null);
    assert.equal(admission.recordRefs.length, 1);
  });

  it('denies a membership revoked after the identity snapshot with forbidden', async () => {
    const { store, memberships, team, alice } = await setup();
    const operationId = uuidv7(FIXED_NOW);
    const ctx = buildContext({
      identity: makeIdentity({ membership: alice.membership }),
      app: APP,
      operation: asOperation(OPERATION),
      operationId,
      source: 'test',
      kind: 'user',
      now: FIXED_NOW,
    });
    assert.deepEqual(ctx.team, { teamId: team.team_id, timezone: 'UTC' });
    await memberships.removeMembership(alice.membership.membership_id);

    const error = await captureStateError(
      admit({ def: makeDef(), inputs: {}, context: ctx, store, memberships }),
    );
    assert.equal(error.code, 'forbidden');
  });

  it('replays a live receipt for an identity older than 24h', async () => {
    // DESIGN §7: receipt check precedes age enforcement for unseen ids.
    const { store, memberships, team, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    const def = recordDef();
    const inputs = { expense: { id: 'rec-1', version: '1' }, title: 'a' };
    const fresh = await admit({
      def,
      inputs,
      context: ctxFor(alice.user.user_id, team.team_id, uuidv7(FIXED_NOW)),
      store,
      memberships,
    });
    const oldId = uuidv7(FIXED_NOW - MAX_OPERATION_ID_AGE_MS - 1);
    const oldCtx = ctxFor(alice.user.user_id, team.team_id, oldId);
    await seedReceipt(
      store,
      makeReceipt({
        ...receiptIdentityParts(oldCtx),
        inputHash: fresh.inputHash,
        outcome: { status: 'committed', result: { marker: 'old' }, recordVersions: [] },
      }),
    );
    const replayed = await admit({ def, inputs, context: oldCtx, store, memberships });
    assert.ok(replayed.replay, 'live receipt replays despite identity age');
    assert.deepEqual(replayed.replay?.outcome, {
      status: 'committed',
      result: { marker: 'old' },
      recordVersions: [],
    });
  });

  it('rejects an unseen identity older than 24h with validation', async () => {
    const { store, memberships, team, alice } = await setup();
    const error = await captureStateError(
      admit({
        def: makeDef(),
        inputs: {},
        context: ctxFor(
          alice.user.user_id,
          team.team_id,
          uuidv7(FIXED_NOW - MAX_OPERATION_ID_AGE_MS - 1),
        ),
        store,
        memberships,
      }),
    );
    assert.equal(error.code, 'validation');
  });

  it('replays after the caller loses authorization', async () => {
    // Replay returns the saved outcome; revocation cannot retroactively
    // un-commit it (fresh invocations still fail — see the forbidden test).
    const { store, memberships, team, alice } = await setup();
    const def = makeDef();
    const operationId = uuidv7(FIXED_NOW);
    const ctx = ctxFor(alice.user.user_id, team.team_id, operationId);
    const first = await admit({ def, inputs: {}, context: ctx, store, memberships });
    assert.equal(first.replay, null);
    await seedReceipt(
      store,
      makeReceipt({
        ...receiptIdentityParts(ctx),
        inputHash: first.inputHash,
        outcome: { status: 'committed', result: { marker: 'saved' }, recordVersions: [] },
      }),
    );
    await memberships.removeMembership(alice.membership.membership_id);
    const replayed = await admit({ def, inputs: {}, context: ctx, store, memberships });
    assert.ok(replayed.replay, 'stored receipt replays despite revoked membership');
  });

  it('treats an omitted input as different from an explicit null', async () => {
    const { store, memberships, team, alice } = await setup();
    const def = makeDef({ inputs: { title: { type: 'scalar', required: false } } });
    const operationId = uuidv7(FIXED_NOW);
    const ctx = ctxFor(alice.user.user_id, team.team_id, operationId);
    const first = await admit({ def, inputs: { title: null }, context: ctx, store, memberships });
    await seedReceipt(
      store,
      makeReceipt({ ...receiptIdentityParts(ctx), inputHash: first.inputHash }),
    );
    const error = await captureStateError(
      admit({ def, inputs: {}, context: ctx, store, memberships }),
    );
    assert.equal(error.code, 'conflict');
  });

  it('propagates membership-lookup failures instead of denying', async () => {
    const { store, team, alice } = await setup();
    const boom = new Error('membership store is down');
    const throwing = {
      findMembership: async () => {
        throw boom;
      },
    };
    const operationId = uuidv7(FIXED_NOW);
    const failure = await captureFailure(
      admit({
        def: makeDef(),
        inputs: {},
        context: ctxFor(alice.user.user_id, team.team_id, operationId),
        store,
        memberships: throwing,
      }),
    );
    assert.strictEqual(failure, boom);
  });
});

/** Spread a context-derived receipt identity into `makeReceipt` opts. */
function receiptIdentityParts(ctx: InvocationContext): {
  readonly app: string;
  readonly owner: string;
  readonly principal: string;
  readonly operation: string;
  readonly operationId: string;
} {
  const identity = receiptIdentityFor(ctx);
  return {
    app: identity.app,
    owner: identity.owner,
    principal: identity.principal,
    operation: identity.operation as string,
    operationId: identity.operationId as string,
  };
}
