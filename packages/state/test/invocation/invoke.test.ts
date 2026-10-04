/**
 * Lane 03 S3 invoke tests (worker B): registry lookup, the admit → execute →
 * fenced-commit pipeline with frozen `now`, fence retry/busy exhaustion,
 * replay short-circuit, storage-error mapping, retry version re-checks, and
 * the `toBusinessError`/`storageToStateError` converters.
 *
 * Aligned to worker A's actuals: `invoke` takes one object (with `clock` and
 * a top-level `execute` seam), handlers receive the `AdmittedCall` alone, and
 * `ExecutionEffects` carries every commit part plus `resolvedDefaults`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { invoke } from '../../src/invocation/invoke.js';
import type { ExecuteHandler, ExecutionEffects } from '../../src/invocation/invoke.js';
import { admit, receiptIdentityFor } from '../../src/invocation/admission.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import type { InterimOperationDef, OperationRegistry } from '../../src/invocation/registry.js';
import { buildContext } from '../../src/invocation/context.js';
import type { StoragePort } from '../../../contracts/src/state.js';
import { createTestMemoryStorage } from '../../src/storage/memory.js';
import { FenceConflictError, StorageConstraintError } from '../../src/storage/port.js';
import { StateError, storageToStateError, toBusinessError } from '../../src/errors.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  asOperationId,
  asRevision,
  asVersion,
  captureFailure,
  captureStateError,
  createMemoryIdentityStore,
  makeBatch,
  makeDef,
  makeEnvelope,
  makeIdentity,
  makeReceipt,
  makeRow,
  seedMember,
  seedReceipt,
  seedRow,
  uuidv7,
} from './fixtures.js';
import type { SeededMember } from './fixtures.js';

const OPERATION = 'Acme.approve';
const MODEL = asModel('Acme.Expense');

async function setup() {
  const { store, probe } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  return { store, probe, memberships, team: alice.team, alice };
}

function identityFor(member: SeededMember) {
  return makeIdentity({ membership: member.membership, email: member.user.email });
}

function registryFor(def: InterimOperationDef): OperationRegistry {
  return new Map([[def.name, def]]);
}

function recordDef(): InterimOperationDef {
  return makeDef({
    inputs: {
      expense: { type: 'record', model: MODEL, versioned: true, required: true },
      title: { type: 'scalar', required: true },
    },
  });
}

function recordInputs() {
  return { expense: { id: 'rec-1', version: '1' }, title: 'hello' };
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

/** Execute stub: approve the admitted expense row, recording observations. */
function approveExecute(capture?: { readonly now: number[]; calls: number }): ExecuteHandler {
  return async (call: AdmittedCall): Promise<ExecutionEffects> => {
    if (capture) {
      capture.now.push(call.context.now);
      capture.calls += 1;
    }
    const ref = call.recordRefs[0];
    assert.ok(ref, 'admitted expense row is visible to execute');
    const current = ref.row;
    return bareEffects({
      writes: [
        {
          kind: 'update',
          model: MODEL,
          id: current.id,
          expectedVersion: current.version,
          row: {
            ...current,
            version: asVersion((current.version as number) + 1),
            updated: call.context.now,
            data: { status: 'approved' },
          },
        },
      ],
      result: { approved: true },
    });
  };
}

describe('invoke', () => {
  it('rejects an unknown operation with validation', async () => {
    const { store, memberships, alice } = await setup();
    const operationId = uuidv7(FIXED_NOW);
    const base = {
      app: 'acme-app',
      envelope: makeEnvelope('Acme.ghost', operationId),
      identity: identityFor(alice),
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute: approveExecute(),
    };
    const error = await captureStateError(invoke({ ...base, registry: registryFor(makeDef()) }));
    assert.equal(error.code, 'validation');
    const empty = await captureStateError(
      invoke({ ...base, registry: new Map<string, InterimOperationDef>() }),
    );
    assert.equal(empty.code, 'validation');
  });

  it('commits execute effects, stages deliveries, and persists the receipt', async () => {
    const { store, probe, memberships, team, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1', data: { status: 'submitted' } });
    const def = recordDef();
    const operationId = uuidv7(FIXED_NOW);
    const envelope = makeEnvelope(OPERATION, operationId, recordInputs());
    const identity = identityFor(alice);
    // Mirror of invoke's internally built context (same app/identity/clock).
    const ctx = buildContext({
      identity,
      operation: asOperation(OPERATION),
      operationId,
      app: 'acme-app',
      source: 'test',
      now: FIXED_NOW,
    });
    const admitted = await admit({ def, inputs: envelope.inputs, context: ctx, store, memberships });
    assert.equal(admitted.replay, null);

    const intent = {
      intentId: 'intent-1',
      operation: asOperation(OPERATION),
      operationId: asOperationId(operationId),
      target: 'mail.send',
      arguments: { to: 'a@example.test' },
      occurrenceIndex: 0,
    };
    const execute: ExecuteHandler = async (call) => ({
      ...(await approveExecute()(call)),
      outbox: [intent],
    });

    const out = await invoke({
      app: 'acme-app',
      registry: registryFor(def),
      envelope,
      identity,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
    });
    assert.equal(out.status, 'committed');
    assert.equal(out.operation_id, operationId);
    assert.deepEqual(out.result, { approved: true });
    assert.deepEqual(out.deliveries, [{ id: 'intent-1', status: 'pending' }]);

    const stored = await store.load(MODEL, asId('rec-1'));
    assert.ok(stored);
    assert.equal(stored.version, 2);
    assert.deepEqual(stored.data, { status: 'approved' });
    assert.deepEqual(
      probe.outboxAll().map((queued) => queued.intentId),
      ['intent-1'],
    );

    const receipt = await store.readReceipt(receiptIdentityFor(ctx));
    assert.ok(receipt, 'receipt persisted under the invocation identity');
    assert.equal(receipt.identity.principal, alice.user.user_id);
    assert.equal(receipt.identity.owner, team.team_id);
    assert.equal(receipt.identity.operation, OPERATION);
    assert.equal(receipt.inputHash, admitted.inputHash);
    assert.deepEqual(receipt.resolvedDefaults, {});
    assert.deepEqual(receipt.outcome, {
      status: 'committed',
      result: { approved: true },
      recordVersions: [{ model: MODEL, id: asId('rec-1'), version: asVersion(2) }],
    });
  });

  it('freezes now across a fenced retry', async () => {
    const { store, memberships, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    let commits = 0;
    const flaky: StoragePort = {
      ...store,
      commit: async (batch) => {
        commits += 1;
        if (commits === 1) {
          throw new FenceConflictError(batch.expectedRevision, batch.expectedRevision);
        }
        return store.commit(batch);
      },
    };
    const capture = { now: [] as number[], calls: 0 };
    const operationId = uuidv7(FIXED_NOW);
    // Advancing clock: proves `now` is read once, not re-read per attempt
    // (a constant clock would pass either way).
    let clockReads = 0;
    const clock = {
      nowMs: () => {
        clockReads += 1;
        return FIXED_NOW + clockReads;
      },
    };
    const out = await invoke({
      app: 'acme-app',
      registry: registryFor(recordDef()),
      envelope: makeEnvelope(OPERATION, operationId, recordInputs()),
      identity: identityFor(alice),
      source: 'test',
      store: flaky,
      memberships,
      clock,
      execute: approveExecute(capture),
    });
    assert.equal(out.status, 'committed');
    assert.equal(capture.calls, 2);
    assert.equal(clockReads, 1);
    assert.deepEqual(capture.now, [FIXED_NOW + 1, FIXED_NOW + 1]);
    const stored = await store.load(MODEL, asId('rec-1'));
    assert.equal(stored?.version, 2);
  });

  it('returns retryable busy after three fenced attempts', async () => {
    const { store, memberships, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    const stuck: StoragePort = {
      ...store,
      commit: async (batch) => {
        throw new FenceConflictError(batch.expectedRevision, batch.expectedRevision);
      },
    };
    const capture = { now: [] as number[], calls: 0 };
    const operationId = uuidv7(FIXED_NOW);
    const error = await captureStateError(
      invoke({
        app: 'acme-app',
        registry: registryFor(recordDef()),
        envelope: makeEnvelope(OPERATION, operationId, recordInputs()),
        identity: identityFor(alice),
        source: 'test',
        store: stuck,
        memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute: approveExecute(capture),
      }),
    );
    assert.equal(error.code, 'busy');
    assert.equal(capture.calls, 3);
    const wire = toBusinessError(error, operationId);
    assert.equal(wire.code, 'busy');
    assert.equal(wire.retryable, true);
    assert.equal(wire.operation_id, operationId);
  });

  it('replays a stored receipt without calling execute', async () => {
    const { store, memberships, team, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    const def = recordDef();
    const operationId = uuidv7(FIXED_NOW);
    const envelope = makeEnvelope(OPERATION, operationId, recordInputs());
    const identity = identityFor(alice);
    const ctx = buildContext({
      identity,
      operation: asOperation(OPERATION),
      operationId,
      app: 'acme-app',
      source: 'test',
      now: FIXED_NOW,
    });
    const admitted = await admit({ def, inputs: envelope.inputs, context: ctx, store, memberships });
    const seededIdentity = receiptIdentityFor(ctx);
    assert.equal(seededIdentity.principal, alice.user.user_id);
    assert.equal(seededIdentity.owner, team.team_id);
    await seedReceipt(
      store,
      makeReceipt({
        app: seededIdentity.app,
        owner: seededIdentity.owner,
        principal: seededIdentity.principal,
        operation: seededIdentity.operation as string,
        operationId: seededIdentity.operationId as string,
        inputHash: admitted.inputHash,
        outcome: {
          status: 'committed',
          result: { marker: 'saved' },
          recordVersions: [{ model: MODEL, id: asId('rec-1'), version: asVersion(1) }],
        },
      }),
    );

    let calls = 0;
    const execute: ExecuteHandler = async () => {
      calls += 1;
      throw new Error('execute must not run on replay');
    };
    const out = await invoke({
      app: 'acme-app',
      registry: registryFor(def),
      envelope,
      identity,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
    });
    assert.equal(out.status, 'replayed');
    assert.equal(out.operation_id, operationId);
    assert.equal(calls, 0);
    assert.deepEqual(out.result, { marker: 'saved' });
  });

  it('passes a saved null result through on replay', async () => {
    const { store, memberships, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    const def = recordDef();
    const operationId = uuidv7(FIXED_NOW);
    const envelope = makeEnvelope(OPERATION, operationId, recordInputs());
    const identity = identityFor(alice);
    const ctx = buildContext({
      identity,
      operation: asOperation(OPERATION),
      operationId,
      app: 'acme-app',
      source: 'test',
      now: FIXED_NOW,
    });
    const admitted = await admit({ def, inputs: envelope.inputs, context: ctx, store, memberships });
    const seededIdentity = receiptIdentityFor(ctx);
    await seedReceipt(
      store,
      makeReceipt({
        app: seededIdentity.app,
        owner: seededIdentity.owner,
        principal: seededIdentity.principal,
        operation: seededIdentity.operation as string,
        operationId: seededIdentity.operationId as string,
        inputHash: admitted.inputHash,
        outcome: { status: 'committed', result: null, recordVersions: [] },
      }),
    );

    const execute: ExecuteHandler = async () => {
      throw new Error('execute must not run on replay');
    };
    const out = await invoke({
      app: 'acme-app',
      registry: registryFor(def),
      envelope,
      identity,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
    });
    assert.equal(out.status, 'replayed');
    assert.ok('result' in out, 'saved null result is present, not omitted');
    assert.equal(out.result, null);
  });

  it('rethrows a saved rejected outcome on replay', async () => {
    const { store, memberships, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    const def = recordDef();
    const operationId = uuidv7(FIXED_NOW);
    const envelope = makeEnvelope(OPERATION, operationId, recordInputs());
    const identity = identityFor(alice);
    const ctx = buildContext({
      identity,
      operation: asOperation(OPERATION),
      operationId,
      app: 'acme-app',
      source: 'test',
      now: FIXED_NOW,
    });
    const admitted = await admit({ def, inputs: envelope.inputs, context: ctx, store, memberships });
    const seededIdentity = receiptIdentityFor(ctx);
    await seedReceipt(
      store,
      makeReceipt({
        app: seededIdentity.app,
        owner: seededIdentity.owner,
        principal: seededIdentity.principal,
        operation: seededIdentity.operation as string,
        operationId: seededIdentity.operationId as string,
        inputHash: admitted.inputHash,
        outcome: { status: 'rejected', code: 'rule_failed', message: 'Nope.' },
      }),
    );

    let calls = 0;
    const execute: ExecuteHandler = async () => {
      calls += 1;
      throw new Error('execute must not run on replay');
    };
    const error = await captureStateError(
      invoke({
        app: 'acme-app',
        registry: registryFor(def),
        envelope,
        identity,
        source: 'test',
        store,
        memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute,
      }),
    );
    assert.equal(error.code, 'rule_failed');
    assert.equal(error.message, 'Nope.');
    assert.equal(calls, 0);
  });

  it('propagates execute business rejections unmapped and unretried, with a rejected receipt', async () => {
    const { store, memberships, team, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-1' });
    const def = recordDef();
    const operationId = uuidv7(FIXED_NOW);
    const revision = await store.readRevision();
    let calls = 0;
    const rejection = new StateError('rule_failed', 'Business says no.');
    const error = await captureStateError(
      invoke({
        app: 'acme-app',
        registry: registryFor(def),
        envelope: makeEnvelope(OPERATION, operationId, recordInputs()),
        identity: identityFor(alice),
        source: 'test',
        store,
        memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute: async () => {
          calls += 1;
          throw rejection;
        },
      }),
    );
    // S5: the ORIGINAL error still propagates untouched after one execute
    // pass, but the rejection is now fenced-receipted for exact replay.
    assert.strictEqual(error, rejection);
    assert.equal(calls, 1);
    const receipt = await store.readReceipt({
      app: 'acme-app',
      owner: team.team_id,
      principal: alice.user.user_id,
      operation: asOperation(OPERATION),
      operationId: asOperationId(operationId),
    });
    assert.ok(receipt !== null, 'expected a rejected receipt to be committed');
    assert.deepEqual(receipt.outcome, {
      status: 'rejected',
      code: 'rule_failed',
      message: 'Business says no.',
    });
    assert.deepEqual(receipt.resolvedDefaults, {});
    assert.equal(receipt.committedRevision, (revision as number) + 1);
  });

  it('maps a duplicate unique claim from execute to conflict without retry', async () => {
    const { store, memberships, alice } = await setup();
    const revision = await store.readRevision();
    await store.commit(
      makeBatch(revision as number, {
        uniqueClaims: [{ model: MODEL, keyName: 'slug', keyValue: 'x', recordId: asId('rec-1') }],
      }),
    );
    let calls = 0;
    const execute: ExecuteHandler = async () => {
      calls += 1;
      return bareEffects({
        uniqueClaims: [{ model: MODEL, keyName: 'slug', keyValue: 'x', recordId: asId('rec-2') }],
      });
    };
    const operationId = uuidv7(FIXED_NOW);
    const error = await captureStateError(
      invoke({
        app: 'acme-app',
        registry: registryFor(makeDef()),
        envelope: makeEnvelope(OPERATION, operationId),
        identity: identityFor(alice),
        source: 'test',
        store,
        memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute,
      }),
    );
    assert.equal(error.code, 'conflict');
    assert.equal(calls, 1);
  });

  it('rethrows unknown storage errors instead of converting them', async () => {
    const { store, memberships, alice } = await setup();
    await seedRow(store, MODEL, { id: 'rec-dup' });
    const execute: ExecuteHandler = async () =>
      bareEffects({ writes: [{ kind: 'insert', model: MODEL, row: makeRow({ id: 'rec-dup' }) }] });
    const operationId = uuidv7(FIXED_NOW);
    const error = await captureFailure(
      invoke({
        app: 'acme-app',
        registry: registryFor(makeDef()),
        envelope: makeEnvelope(OPERATION, operationId),
        identity: identityFor(alice),
        source: 'test',
        store,
        memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute,
      }),
    );
    assert.ok(error instanceof StorageConstraintError);
    assert.equal(error.kind, 'unknown');
    assert.ok(!(error instanceof StateError));
  });

  it('re-checks submitted versions on retry and never overwrites', async () => {
    const { store, memberships, alice } = await setup();
    const row = await seedRow(store, MODEL, { id: 'rec-1', data: { status: 'submitted' } });
    let commits = 0;
    const racing: StoragePort = {
      ...store,
      commit: async (batch) => {
        commits += 1;
        if (commits === 1) {
          const current = await store.readRevision();
          await store.commit(
            makeBatch(current as number, {
              writes: [
                {
                  kind: 'update',
                  model: MODEL,
                  id: row.id,
                  expectedVersion: row.version,
                  row: {
                    ...row,
                    version: asVersion(2),
                    updated: FIXED_NOW,
                    data: { status: 'racer' },
                  },
                },
              ],
            }),
          );
          throw new FenceConflictError(batch.expectedRevision, asRevision((current as number) + 1));
        }
        return store.commit(batch);
      },
    };
    const operationId = uuidv7(FIXED_NOW);
    const error = await captureStateError(
      invoke({
        app: 'acme-app',
        registry: registryFor(recordDef()),
        envelope: makeEnvelope(OPERATION, operationId, recordInputs()),
        identity: identityFor(alice),
        source: 'test',
        store: racing,
        memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute: approveExecute(),
      }),
    );
    assert.equal(error.code, 'conflict');
    const stored = await store.load(MODEL, asId('rec-1'));
    assert.ok(stored);
    assert.equal(stored.version, 2);
    assert.deepEqual(stored.data, { status: 'racer' });
    assert.equal(await store.readRevision(), 2);
  });
});

describe('converters', () => {
  it('toBusinessError maps code, message, operation_id, fields, and retryable', async () => {
    const { store, memberships, team, alice } = await setup();
    const operationId = uuidv7(FIXED_NOW);
    const identity = identityFor(alice);
    const ctx = buildContext({
      identity,
      operation: asOperation(OPERATION),
      operationId,
      app: 'acme-app',
      source: 'test',
      now: FIXED_NOW,
    });
    assert.deepEqual(ctx.team, { teamId: team.team_id, timezone: 'UTC' });
    const def = makeDef({ inputs: { title: { type: 'scalar', required: true } } });
    const missing = await captureStateError(
      admit({ def, inputs: {}, context: ctx, store, memberships }),
    );
    assert.equal(missing.code, 'validation');

    const wire = toBusinessError(missing, operationId);
    assert.equal(wire.code, 'validation');
    assert.equal(wire.message, missing.message);
    assert.equal(wire.operation_id, operationId);
    assert.ok(wire.fields?.some((field) => field.path === '/title'));
    assert.equal(wire.retryable ?? false, false);

    const busy = toBusinessError(
      new StateError('busy', 'Contended.', null, { retryable: true }),
      operationId,
    );
    assert.equal(busy.code, 'busy');
    assert.equal(busy.retryable, true);
    assert.ok(
      !('retryable' in toBusinessError(new StateError('busy', 'Contended.'))),
      'retryable passes through only when the StateError sets it',
    );

    assert.ok(!('operation_id' in toBusinessError(missing)));
  });

  it('storageToStateError maps storage failures and rethrows the rest', async () => {
    const fence = storageToStateError(new FenceConflictError(asRevision(1), asRevision(2)));
    assert.ok(fence instanceof StateError);
    assert.equal(fence.code, 'busy');
    assert.equal(fence.retryable, true);

    for (const kind of ['unique', 'version', 'receipt_reuse'] as const) {
      const mapped = storageToStateError(new StorageConstraintError(kind, 'detail'));
      assert.ok(mapped instanceof StateError, kind);
      assert.equal(mapped.code, 'conflict', kind);
    }
    const reference = storageToStateError(new StorageConstraintError('reference', 'detail'));
    assert.ok(reference instanceof StateError);
    assert.equal(reference.code, 'validation');

    const unknown = new StorageConstraintError('unknown', 'record x already exists');
    assert.strictEqual(await captureFailure(() => storageToStateError(unknown)), unknown);
    const boom = new Error('boom');
    assert.strictEqual(storageToStateError(boom), boom);
  });
});
