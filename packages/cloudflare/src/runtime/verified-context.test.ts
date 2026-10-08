import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InvocationContext, OperationId, OperationName, StoragePort } from '@canlang/contracts';
import { makeDatetime, makeUserRef, ValueError } from '@canlang/values';
import { createContext } from './context.js';

const admitted: InvocationContext = {
  kind: 'user', app: 'VerifiedContext',
  actor: { userId: 'verified-user', email: 'member@example.test', emailVerified: true },
  team: { teamId: 'verified-team', timezone: 'Europe/Brussels' },
  operation: 'VerifiedContext.observe' as OperationName,
  operationId: '01a11b07-5e2b-7000-8000-000000000001' as OperationId,
  source: 'mcp', now: 1791454830123,
};
const store = {} as StoragePort;

describe('qualified source facts on the handler context', () => {
  it('preserves the exact unqualified shape and supplied clock evaluation', () => {
    let reads = 0;
    const caller = { userId: 'anonymous', roles: [] };
    const clock = () => ++reads;
    const context = createContext({ caller, store, clock });
    assert.deepEqual(Object.keys(context).sort(), ['caller', 'clock', 'memberships', 'preferences', 'store']);
    assert.equal(context.caller, caller);
    assert.equal(context.clock, clock);
    assert.equal(reads, 0);
    assert.equal(context.clock(), 1);
    for (const name of ['actor', 'team', 'now', 'operation', 'canonical']) assert.equal(Object.hasOwn(context, name), false);
  });

  it('keeps the default clock lazy outside qualified execution', (t) => {
    let reads = 0;
    t.mock.method(Date, 'now', () => 100 + ++reads);
    const context = createContext({ caller: { userId: 'legacy', roles: [] }, store });
    assert.equal(reads, 0);
    assert.equal(context.clock(), 101);
    assert.equal(context.clock(), 102);
  });

  it('projects owning exact values and admitted source identity rather than caller labels', () => {
    let reads = 0;
    const context = createContext({ caller: { userId: 'unrelated-label', roles: ['owner'] }, store, clock: () => ++reads, qualified: admitted });
    assert.deepEqual(context.actor, makeUserRef('verified-user'));
    assert.deepEqual(context.now, makeDatetime(1791454830123n));
    assert.deepEqual(context.team, { id: 'verified-team', timezone: 'Europe/Brussels' });
    assert.deepEqual(context.operation, { id: admitted.operationId, source: 'mcp' });
    assert.notEqual(context.operation?.id, admitted.operation);
    assert.deepEqual(Object.keys(context.actor ?? {}).sort(), ['id', 'kind']);
    assert.equal(reads, 0);
  });

  it('copies and freezes compound facts without freezing or exposing the admitted carrier', () => {
    const actor = { userId: 'copy-user' };
    const team = { teamId: 'copy-team', timezone: 'Europe/Brussels' };
    const qualified = { ...admitted, actor, team };
    const context = createContext({ caller: { userId: 'label', roles: [] }, store, qualified });
    actor.userId = 'changed-user';
    team.teamId = 'changed-team';
    team.timezone = 'UTC';
    qualified.source = 'changed-source';
    assert.equal(context.actor?.id, 'copy-user');
    assert.deepEqual(context.team, { id: 'copy-team', timezone: 'Europe/Brussels' });
    assert.equal(context.operation?.source, 'mcp');
    for (const value of [context.actor, context.team, context.now, context.operation]) assert.equal(Object.isFrozen(value), true);
    assert.throws(() => Object.assign(context.actor!, { id: 'forged' }), TypeError);
    assert.throws(() => Object.assign(context.team!, { timezone: 'UTC' }), TypeError);
    assert.throws(() => Object.assign(context.operation!, { id: 'forged' }), TypeError);
    assert.equal(Object.isFrozen(qualified), false);
  });

  it('preserves null actor and team without attribution or caller fallback', () => {
    const context = createContext({ caller: { userId: 'anonymous', roles: ['public'] }, store, qualified: { ...admitted, actor: null, team: null } });
    assert.equal(context.actor, null);
    assert.equal(context.team, null);
    assert.equal(Object.hasOwn(context, 'actor'), true);
    assert.equal(Object.hasOwn(context, 'team'), true);
    assert.deepEqual(context.operation, { id: admitted.operationId, source: 'mcp' });
  });

  it('retains owning constructor failures and never samples the clock for conversion', () => {
    let reads = 0;
    const deps = { caller: { userId: 'label', roles: [] }, store, clock: () => ++reads };
    assert.throws(() => createContext({ ...deps, qualified: { ...admitted, actor: { userId: '' }, now: Number.NaN } }), (error: unknown) => error instanceof ValueError && error.code === 'invalid-construction');
    assert.throws(() => createContext({ ...deps, qualified: { ...admitted, now: 253402300800000 } }), (error: unknown) => error instanceof ValueError && error.code === 'out-of-range');
    assert.equal(reads, 0);
  });
});
