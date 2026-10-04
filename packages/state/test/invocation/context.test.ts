/**
 * Lane 03 S3 `buildContext` tests (worker B): identity mapping, UUIDv7
 * operation-id validation, the 24h age / 5m future clock window (DESIGN §7),
 * and trusted/public actor handling.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Single adjustment point for worker A's actual context location/signature.
import { assertOperationIdAge, buildContext } from '../../src/invocation/context.js';
import {
  FIXED_NOW,
  MAX_OPERATION_ID_AGE_MS,
  OPERATION_ID_FUTURE_TOLERANCE_MS,
  asOperation,
  captureStateError,
  makeIdentity,
  uuidv7,
} from './fixtures.js';

function baseInput(operationId: string): Parameters<typeof buildContext>[0] {
  return {
    identity: makeIdentity(),
    app: 'acme-app',
    operation: asOperation('Acme.approve'),
    operationId,
    source: 'browser',
    kind: 'user',
    now: FIXED_NOW,
  };
}

describe('buildContext', () => {
  it('maps actor, team, operation, now, source, and kind', () => {
    const operationId = uuidv7(FIXED_NOW);
    const ctx = buildContext(baseInput(operationId));
    assert.equal(ctx.kind, 'user');
    assert.equal(ctx.app, 'acme-app');
    assert.deepEqual(ctx.actor, {
      userId: 'user-alice',
      email: 'alice@example.test',
      emailVerified: true,
    });
    assert.deepEqual(ctx.team, { teamId: 'team-a', timezone: 'UTC' });
    assert.equal(ctx.operation, 'Acme.approve');
    assert.equal(ctx.operationId, operationId);
    assert.equal(ctx.source, 'browser');
    assert.equal(ctx.now, FIXED_NOW);
    assert.equal(ctx.trustedSource, undefined);
  });

  it('rejects a non-v7 (v4) operation id with validation', async () => {
    const error = await captureStateError(() =>
      buildContext(baseInput('550e8400-e29b-41d4-a716-446655440000')),
    );
    assert.equal(error.code, 'validation');
  });

  it('rejects a malformed operation id with validation', async () => {
    const error = await captureStateError(() => buildContext(baseInput('not-a-uuid')));
    assert.equal(error.code, 'validation');
  });

  it('does not enforce UUID variant bits (documented implementation leniency)', () => {
    // Worker A's documented choice: only hex shape + version nibble 7 are
    // enforced, since admission needs the embedded timestamp. Strict RFC 9562
    // would reject a non-10 variant; flagged as a strictness deviation in the
    // S3 test report for coordinator review.
    const lax = `${uuidv7(FIXED_NOW).slice(0, 19)}0bbb-000000000000`;
    const ctx = buildContext(baseInput(lax));
    assert.equal(ctx.operationId, lax);
  });

  it('rejects ids older than 24h with validation', async () => {
    const id = uuidv7(FIXED_NOW - MAX_OPERATION_ID_AGE_MS - 1);
    const error = await captureStateError(() => assertOperationIdAge(id, FIXED_NOW));
    assert.equal(error.code, 'validation');
  });

  it('accepts an id exactly 24h old (now - ts <= MAX)', () => {
    assertOperationIdAge(uuidv7(FIXED_NOW - MAX_OPERATION_ID_AGE_MS), FIXED_NOW);
  });

  it('rejects ids more than 5 minutes in the future', async () => {
    const id = uuidv7(FIXED_NOW + OPERATION_ID_FUTURE_TOLERANCE_MS + 1);
    const error = await captureStateError(() => assertOperationIdAge(id, FIXED_NOW));
    assert.equal(error.code, 'validation');
  });

  it('accepts an id exactly 5 minutes in the future', () => {
    assertOperationIdAge(uuidv7(FIXED_NOW + OPERATION_ID_FUTURE_TOLERANCE_MS), FIXED_NOW);
  });

  it('builds a context for an old id; age is enforced by admit after the receipt check', () => {
    // DESIGN §7 orders receipt-before-age so live receipts replay past 24h.
    const ctx = buildContext(baseInput(uuidv7(FIXED_NOW - MAX_OPERATION_ID_AGE_MS - 1)));
    assert.equal(ctx.now, FIXED_NOW);
  });

  it('requires trustedSource for trusted kind', async () => {
    const error = await captureStateError(() =>
      buildContext({
        ...baseInput(uuidv7(FIXED_NOW)),
        kind: 'trusted',
        identity: makeIdentity({ actor: null, membership: null }),
      }),
    );
    assert.equal(error.code, 'validation');
  });

  it('preserves null actor with trustedSource for trusted kind', () => {
    const ctx = buildContext({
      ...baseInput(uuidv7(FIXED_NOW)),
      kind: 'trusted',
      trustedSource: 'scheduler',
      identity: makeIdentity({ actor: null, membership: null }),
    });
    assert.equal(ctx.kind, 'trusted');
    assert.equal(ctx.actor, null);
    assert.equal(ctx.trustedSource, 'scheduler');
    assert.deepEqual(ctx.team, { teamId: 'team-a', timezone: 'UTC' });
  });

  it('preserves null actor for public user-kind requests', () => {
    const ctx = buildContext({
      ...baseInput(uuidv7(FIXED_NOW)),
      identity: makeIdentity({ actor: null, membership: null }),
    });
    assert.equal(ctx.kind, 'user');
    assert.equal(ctx.actor, null);
    assert.deepEqual(ctx.team, { teamId: 'team-a', timezone: 'UTC' });
  });
});
