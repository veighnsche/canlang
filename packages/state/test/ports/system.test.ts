/**
 * Lane 03 S6 system-command tests: unknown-command rejection, the
 * readers-only staging context (no store/commit keys), the outbox ack flow,
 * schedule cancel/replace round-trips, same-batch ack+stage, and malformed
 * staged intents failing closed with nothing persisted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OutboxIntent } from '@canlang/contracts';
import {
  createSystemRegistry,
  enrollSystemCommandCommitCheck,
  systemCommandStageRevision,
  readSystemCommandRetainedOutbox,
  type SystemCommandContext,
  defineSystemCommand,
  outboxAckCommand,
  scheduleCancelCommand,
  scheduleReplaceCommand,
} from '../../src/ports/index.js';
import { asOperationId, makeBatch } from '../invocation/fixtures.js';
import {
  FIXED_NOW,
  asOperation,
  captureStateError,
  invokeStage,
  makeStagedIntent,
  makeStagingHandler,
  pendingIntentIds,
  setupPortsWorld,
} from './fixtures.js';

function runCtx(operationId: string) {
  return { actor: 'operator', now: FIXED_NOW, operation: 'sys', operationId };
}

function registry() {
  return createSystemRegistry([outboxAckCommand, scheduleCancelCommand, scheduleReplaceCommand]);
}

describe('createSystemRegistry', () => {
  it('rejects an unknown command name with validation', async () => {
    const world = await setupPortsWorld();
    const error = await captureStateError(() =>
      registry().run('nope.missing', {}, runCtx('sys-run-0'), { store: world.store }),
    );
    assert.equal(error.code, 'validation');
  });

  it('gives staging contexts readers only: no store or commit keys', async () => {
    const world = await setupPortsWorld();
    let seen: Record<string, unknown> | null = null;
    const inspect = defineSystemCommand({
      name: 'test.inspect',
      stage: (_args, ctx) => {
        seen = { ...ctx };
        return { result: null };
      },
    });
    const commands = createSystemRegistry([inspect]);
    await commands.run('test.inspect', {}, runCtx('sys-run-0'), { store: world.store });
    assert.ok(seen !== null);
    assert.deepEqual(Object.keys(seen).sort(), ['actor', 'load', 'now', 'operation', 'query']);
    assert.ok(!('store' in seen) && !('commit' in seen));
    assert.equal(typeof seen['load'], 'function');
    assert.equal(typeof seen['query'], 'function');
  });

  it('acks intents idempotently: unknown and repeated acks are a no-op', async () => {
    const world = await setupPortsWorld();
    const out = await invokeStage(world, {
      execute: makeStagingHandler({
        intents: [makeStagedIntent('sys-a'), makeStagedIntent('sys-b')],
      }),
    });
    assert.equal(out.status, 'committed');
    assert.deepEqual(await pendingIntentIds(world.store), ['sys-a', 'sys-b']);
    const commands = registry();
    const deps = { store: world.store };
    const acked = await commands.run('outbox.ack', { intentIds: ['sys-a'] }, runCtx('sys-run-1'), deps);
    assert.deepEqual(acked.result, { requested: 1 });
    assert.deepEqual(await pendingIntentIds(world.store), ['sys-b']);
    await commands.run('outbox.ack', { intentIds: ['sys-unknown'] }, runCtx('sys-run-2'), deps);
    assert.deepEqual(await pendingIntentIds(world.store), ['sys-b']);
    await commands.run('outbox.ack', { intentIds: ['sys-a'] }, runCtx('sys-run-3'), deps);
    assert.deepEqual(await pendingIntentIds(world.store), ['sys-b']);
  });

  it('reads the actual original outbox after acknowledgement inside the five-key issued stage', async () => {
    const world = await setupPortsWorld();
    await invokeStage(world, { execute: makeStagingHandler({ intents: [makeStagedIntent('retained-a')] }) });
    const original = await world.store.outboxGet('retained-a');
    assert.ok(original?.originalCommit);
    await registry().run('outbox.ack', { intentIds: ['retained-a'] }, runCtx('retained-ack'), { store: world.store });
    let captured: SystemCommandContext | undefined;
    const read = defineSystemCommand({ name: 'test.retained', stage: async (_args, ctx) => {
      captured = ctx;
      assert.deepEqual(Object.keys(ctx).sort(), ['actor', 'load', 'now', 'operation', 'query']);
      const retained = await readSystemCommandRetainedOutbox(ctx, 'retained-a');
      assert.deepEqual(retained?.intent, original.intent);
      assert.deepEqual(retained?.originalCommit, original.originalCommit);
      assert.equal(retained?.status, 'dispatched');
      assert.equal(await readSystemCommandRetainedOutbox(ctx, 'missing'), null);
      return { result: retained };
    } });
    await createSystemRegistry([read]).run(read.name, {}, runCtx('retained-read'), { store: world.store });
    assert.throws(() => readSystemCommandRetainedOutbox(captured!, 'retained-a'), /closed or poisoned/);
    assert.throws(() => readSystemCommandRetainedOutbox({ ...captured! }, 'retained-a'), /not issued/);
  });

  it('poisons copied retained-reader contexts and does not commit after a caught forgery', async () => {
    const world = await setupPortsWorld();
    const before = await world.store.readRevision();
    const read = defineSystemCommand({ name: 'test.retained-forgery', stage: (_args, ctx) => {
      assert.throws(() => readSystemCommandRetainedOutbox({ ...ctx }, 'anything'), /not issued/);
      return { result: null };
    } });
    const error = await captureStateError(() => createSystemRegistry([read]).run(read.name, {},
      runCtx('retained-forgery'), { store: world.store }));
    assert.equal(error.code, 'validation');
    assert.equal(await world.store.readRevision(), before);
  });

  it('refuses fence drift after the original retained carrier read', async () => {
    const world = await setupPortsWorld();
    await invokeStage(world, { execute: makeStagingHandler({ intents: [makeStagedIntent('retained-race')] }) });
    const original = await world.store.outboxGet('retained-race');
    const read = defineSystemCommand({ name: 'test.retained-race', stage: async (_args, ctx) => {
      const retained = await readSystemCommandRetainedOutbox(ctx, 'retained-race');
      assert.ok(retained?.originalCommit);
      await world.store.commit(makeBatch(await world.store.readRevision(), {}));
      return { result: retained };
    } });
    const error = await captureStateError(() => createSystemRegistry([read]).run(read.name, {},
      runCtx('retained-race'), { store: world.store }));
    assert.equal(error.code, 'busy');
    assert.deepEqual(await world.store.outboxGet('retained-race'), original);
  });

  it('withholds a run with an unawaited retained read and closes the pending reader', async () => {
    const world = await setupPortsWorld(), before = await world.store.readRevision();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalRead = world.store.outboxGet;
    world.store.outboxGet = async id => { await gate; return originalRead(id); };
    let pending: Promise<unknown> | undefined;
    const read = defineSystemCommand({ name: 'test.retained-pending', stage: (_args, ctx) => {
      pending = readSystemCommandRetainedOutbox(ctx, 'pending').catch(error => error);
      return { result: null };
    } });
    const error = await captureStateError(() => createSystemRegistry([read]).run(read.name, {},
      runCtx('retained-pending'), { store: world.store }));
    assert.equal(error.code, 'validation');
    release();
    assert.match(String(await pending), /crossed its original stage/);
    assert.equal(await world.store.readRevision(), before);
  });

  it('replaces, updates, and cancels schedules via scheduleGet', async () => {
    const world = await setupPortsWorld();
    const commands = registry();
    const deps = { store: world.store };
    const replaced = await commands.run(
      'schedule.replace',
      { key: 'sys-k', at: 5_000, event: 'Acme.due', payload: { n: 1 } },
      runCtx('sys-run-1'),
      deps,
    );
    assert.deepEqual(replaced.result, { key: 'sys-k' });
    assert.deepEqual(await world.store.scheduleGet('sys-k'), {
      key: 'sys-k',
      at: 5_000,
      event: 'Acme.due',
      payload: { n: 1 },
    });
    await commands.run(
      'schedule.replace',
      { key: 'sys-k', at: 6_000, event: 'Acme.due', payload: {} },
      runCtx('sys-run-2'),
      deps,
    );
    assert.deepEqual((await world.store.scheduleGet('sys-k'))?.at, 6_000);
    await commands.run('schedule.cancel', { keys: ['sys-k'] }, runCtx('sys-run-3'), deps);
    assert.equal(await world.store.scheduleGet('sys-k'), null);
    // Canceling an absent key — or an empty list — commits a no-op batch.
    await commands.run('schedule.cancel', { keys: ['missing'] }, runCtx('sys-run-4'), deps);
    const empty = await commands.run('schedule.cancel', { keys: [] }, runCtx('sys-run-5'), deps);
    assert.deepEqual(empty.result, { requested: 0 });
  });

  it('acks an intent staged in the same run batch', async () => {
    const world = await setupPortsWorld();
    const stageack = defineSystemCommand({
      name: 'test.stageack',
      stage: (args) => {
        const intentId = args['intentId'] as string;
        const operationId = args['operationId'] as string;
        const intent: OutboxIntent = {
          intentId,
          operation: asOperation('Acme.stage'),
          operationId: asOperationId(operationId),
          target: 'mail.send',
          arguments: {},
          occurrenceIndex: 0,
        };
        return { outbox: [intent], outboxAck: [intentId], result: { intentId } };
      },
    });
    const commands = createSystemRegistry([stageack]);
    await commands.run(
      'test.stageack',
      { intentId: 'sys-both', operationId: 'sys-run-1' },
      runCtx('sys-run-1'),
      { store: world.store },
    );
    assert.deepEqual(await pendingIntentIds(world.store), []);
  });

  it('rejects an empty or missing ack id list with validation', async () => {
    const world = await setupPortsWorld();
    const commands = registry();
    const deps = { store: world.store };
    // Contrast schedule.cancel, where an empty list is an allowed no-op.
    for (const args of [{ intentIds: [] }, {}]) {
      const error = await captureStateError(() =>
        commands.run('outbox.ack', args, runCtx('sys-run-0'), deps),
      );
      assert.equal(error.code, 'validation');
    }
  });

  it('rejects malformed schedule.replace args with validation', async () => {
    const world = await setupPortsWorld();
    const commands = registry();
    const deps = { store: world.store };
    const good = { key: 'sys-k', at: 5_000, event: 'Acme.due', payload: { n: 1 } };
    const bads: unknown[] = [
      { ...good, key: '' },
      { ...good, key: undefined },
      { ...good, at: -1 },
      { ...good, at: Number.NaN },
      { ...good, event: '' },
      { ...good, payload: [] },
      { ...good, payload: undefined },
    ];
    for (const args of bads) {
      const error = await captureStateError(() =>
        commands.run('schedule.replace', args, runCtx('sys-run-0'), deps),
      );
      assert.equal(error.code, 'validation');
    }
    assert.equal(await world.store.scheduleGet('sys-k'), null);
  });

  it('rejects non-object args and bad run identities with validation', async () => {
    const world = await setupPortsWorld();
    const commands = registry();
    const deps = { store: world.store };
    for (const args of [[], 'keys', null]) {
      const error = await captureStateError(() =>
        commands.run('schedule.cancel', args, runCtx('sys-run-0'), deps),
      );
      assert.equal(error.code, 'validation');
    }
    for (const operationId of ['', 'x'.repeat(129)]) {
      const error = await captureStateError(() =>
        commands.run('schedule.cancel', { keys: [] }, runCtx(operationId), deps),
      );
      assert.equal(error.code, 'validation');
    }
  });

  it('maps a lost run fence to retryable busy', async () => {
    const world = await setupPortsWorld();
    // The stage hook runs between run()'s revision read and its commit, so a
    // direct commit there steals the fence deterministically.
    const steal = defineSystemCommand({
      name: 'test.steal',
      stage: async () => {
        await world.store.commit(makeBatch(await world.store.readRevision()));
        return { result: null };
      },
    });
    const commands = createSystemRegistry([steal]);
    const error = await captureStateError(() =>
      commands.run('test.steal', {}, runCtx('sys-run-0'), { store: world.store }),
    );
    assert.equal(error.code, 'busy');
    assert.equal(error.retryable, true);
  });

  it('reads an absent staged result as null', async () => {
    const world = await setupPortsWorld();
    const noresult = defineSystemCommand({
      name: 'test.noresult',
      stage: () => ({}),
    });
    const commands = createSystemRegistry([noresult]);
    const out = await commands.run('test.noresult', {}, runCtx('sys-run-0'), {
      store: world.store,
    });
    assert.equal(out.result, null);
  });

  it('fails a run with a malformed staged intent and persists nothing', async () => {
    const world = await setupPortsWorld();
    const badstage = defineSystemCommand({
      name: 'test.badstage',
      stage: () => ({
        outbox: [
          {
            intentId: '',
            operation: asOperation('Acme.stage'),
            operationId: asOperationId('sys-run-1'),
            target: 'mail.send',
            arguments: {},
            occurrenceIndex: 0,
          },
        ],
      }),
    });
    const commands = createSystemRegistry([badstage]);
    const before = await world.store.readRevision();
    const error = await captureStateError(() =>
      commands.run('test.badstage', {}, runCtx('sys-run-1'), { store: world.store }),
    );
    assert.equal(error.code, 'validation');
    assert.equal(await world.store.readRevision(), before);
    assert.deepEqual(await pendingIntentIds(world.store), []);
  });
});


describe('private original-stage commit checks', () => {
  it('closes the issued stage and commits detached original effects after one strict check', async () => {
    const world = await setupPortsWorld(), revision = await world.store.readRevision();
    let issued!: SystemCommandContext, checks = 0;
    const staged = { outboxAck: ['original-id'], result: { verdict: true } };
    let batch: Parameters<typeof world.store.commit>[0] | undefined;
    const store = { ...world.store, commit: async (input: Parameters<typeof world.store.commit>[0]) => {
      batch = input; return world.store.commit(input);
    } };
    const command = defineSystemCommand({ name: 'test.checked', stage: (_args, ctx) => {
      issued = ctx; assert.equal(systemCommandStageRevision(ctx), revision);
      enrollSystemCommandCommitCheck(ctx, async () => {
        checks++; staged.outboxAck[0] = 'changed-id'; staged.result.verdict = false; return true;
      }); return staged;
    } });
    const result = await createSystemRegistry([command]).run(command.name, {}, runCtx('checked-run'), { store });
    assert.equal(checks, 1); assert.equal(result.revision, revision + 1);
    assert.deepEqual(batch?.outboxAck, ['original-id']); assert.deepEqual(result.result, { verdict: true });
    assert.throws(() => systemCommandStageRevision(issued), /closed or poisoned/);
    assert.throws(() => enrollSystemCommandCommitCheck(issued, () => true), /closed or poisoned/);
    await assert.rejects(issued.load(world.model, 'absent' as never), /crossed its original stage/);
  });
  for (const mode of ['false', 'unknown', 'throw', 'copied', 'closed-enrollment', 'closed-reader', 'budget'] as const) {
    it(`refuses ${mode} without committing after a caught context failure`, async () => {
      const world = await setupPortsWorld(), revision = await world.store.readRevision(); let commits = 0;
      const store = { ...world.store, commit: async (input: Parameters<typeof world.store.commit>[0]) => {
        commits++; return world.store.commit(input);
      } };
      const command = defineSystemCommand({ name: 'test.refused', stage: (_args, ctx) => {
        if (mode === 'copied') assert.throws(() => enrollSystemCommandCommitCheck({ ...ctx }, () => true), /not issued/);
        else if (mode === 'budget') {
          for (let index = 0; index < 128; index++) enrollSystemCommandCommitCheck(ctx, () => true);
          assert.throws(() => enrollSystemCommandCommitCheck(ctx, () => true), /bounded/);
        } else enrollSystemCommandCommitCheck(ctx, async () => {
          if (mode === 'closed-enrollment') { assert.throws(() => enrollSystemCommandCommitCheck(ctx, () => true), /closed/); return true; }
          if (mode === 'closed-reader') { await assert.rejects(ctx.load(world.model, 'absent' as never), /crossed/); return true; }
          if (mode === 'throw') throw new Error('evidence read failed');
          return (mode === 'unknown' ? undefined : false) as unknown as boolean;
        }); return { outboxAck: ['must-remain'], result: true };
      } });
      await assert.rejects(createSystemRegistry([command]).run(command.name, {}, runCtx('refused-run'), { store }));
      assert.equal(commits, 0); assert.equal(await world.store.readRevision(), revision);
    });
  }
  it('validates staged effects before consuming enrolled checks', async () => {
    const world = await setupPortsWorld(); let checks = 0;
    const command = defineSystemCommand({ name: 'test.invalid', stage: (_args, ctx) => {
      enrollSystemCommandCommitCheck(ctx, () => { checks++; return true; }); return { outboxAck: [''] };
    } });
    await assert.rejects(createSystemRegistry([command]).run(command.name, {}, runCtx('invalid-run'), { store: world.store }));
    assert.equal(checks, 0); assert.equal(await world.store.readRevision(), 0);
  });
  it('refuses an unawaited original reader without committing', async () => {
    const world = await setupPortsWorld(); let resolve!: (value: null) => void; let read!: Promise<unknown>;
    const store = { ...world.store, load: () => new Promise<null>(done => { resolve = done; }) };
    const command = defineSystemCommand({ name: 'test.unawaited', stage: (_args, ctx) => {
      read = ctx.load(world.model, 'absent' as never); void read.catch(() => {}); return { outboxAck: ['must-remain'] };
    } });
    await assert.rejects(createSystemRegistry([command]).run(command.name, {}, runCtx('unawaited-run'), { store }), /unawaited/);
    resolve(null); await assert.rejects(read, /crossed/); assert.equal(await world.store.readRevision(), 0);
  });
});


describe('registry-issued read-only system execution', () => {
  it('settles all three tracked readers, returns a frozen detached result, and closes without committing resources', async () => {
    const world = await setupPortsWorld();
    await invokeStage(world, { execute: makeStagingHandler({ intents: [makeStagedIntent('read-only-original')] }) });
    const revision = await world.store.readRevision(), retained = await world.store.outboxGet('read-only-original');
    let issued!: SystemCommandContext, commits = 0;
    const value = { nested: { accepted: true } };
    const store = { ...world.store, commit: async (batch: Parameters<typeof world.store.commit>[0]) => {
      commits++; return world.store.commit(batch);
    } };
    const command = defineSystemCommand({ name: 'test.read-only', stage: () => ({}), read: async (_args, ctx) => {
      issued = ctx;
      assert.deepEqual(Object.keys(ctx).sort(), ['actor', 'load', 'now', 'operation', 'query']);
      assert.equal(systemCommandStageRevision(ctx), revision);
      const [loaded, selected, original] = await Promise.all([
        ctx.load(world.model, 'absent' as never),
        ctx.query({ model: world.model, authority: 'owner', archived: 'include' }),
        readSystemCommandRetainedOutbox(ctx, 'read-only-original'),
      ]);
      assert.equal(loaded, null); assert.ok(Array.isArray(selected)); assert.deepEqual(original, retained);
      return value;
    } });
    const result = await createSystemRegistry([command]).read(command.name, {}, runCtx('read-only'), { store });
    assert.equal(result.revision, revision); assert.deepEqual(result.result, value);
    assert.notEqual(result.result, value); assert.ok(Object.isFrozen(result.result));
    assert.ok(Object.isFrozen((result.result as typeof value).nested)); value.nested.accepted = false;
    assert.equal((result.result as typeof value).nested.accepted, true);
    assert.equal(commits, 0); assert.equal(await world.store.readRevision(), revision);
    assert.deepEqual(await world.store.outboxGet('read-only-original'), retained);
    assert.throws(() => systemCommandStageRevision(issued), /closed or poisoned/);
    assert.throws(() => readSystemCommandRetainedOutbox(issued, 'read-only-original'), /closed or poisoned/);
    await assert.rejects(issued.load(world.model, 'absent' as never), /crossed/);
  });
  for (const mode of ['copied', 'caught-read-failure', 'write-staging', 'commit-check', 'drift'] as const) {
    it(`refuses ${mode}, including caught capability failures, with zero registry commits`, async () => {
      const world = await setupPortsWorld(), revision = await world.store.readRevision(); let commits = 0;
      let issued!: SystemCommandContext;
      const store = { ...world.store,
        ...(mode === 'caught-read-failure' ? { load: async () => { throw new Error('reader failed'); } } : {}),
        commit: async (batch: Parameters<typeof world.store.commit>[0]) => { commits++; return world.store.commit(batch); },
      };
      const command = defineSystemCommand({ name: 'test.refused-read', stage: () => ({}), read: async (_args, ctx) => {
        issued = ctx;
        if (mode === 'copied') assert.throws(() => systemCommandStageRevision({ ...ctx }), /not issued/);
        if (mode === 'caught-read-failure') await assert.rejects(ctx.load(world.model, 'absent' as never), /reader failed/);
        if (mode === 'commit-check') assert.throws(() => enrollSystemCommandCommitCheck(ctx, () => true), /Read-only/);
        if (mode === 'drift') await world.store.commit(makeBatch(revision));
        return mode === 'write-staging' ? { writes: [] } : { accepted: true };
      } });
      const error = await captureStateError(() => createSystemRegistry([command]).read(command.name, {}, runCtx('refused-read'), { store }));
      assert.equal(error.code, mode === 'drift' ? 'busy' : 'validation');
      if (mode === 'drift') assert.equal(error.retryable, true);
      assert.equal(commits, 0); assert.equal(await world.store.readRevision(), revision + (mode === 'drift' ? 1 : 0));
      assert.throws(() => systemCommandStageRevision(issued), /closed or poisoned/);
    });
  }
  for (const kind of ['load', 'query', 'retained'] as const) {
    it(`refuses an unawaited ${kind} read and closes it after settlement`, async () => {
      const world = await setupPortsWorld(), revision = await world.store.readRevision();
      let release!: () => void, pending!: Promise<unknown>;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const store = { ...world.store,
        load: async (...args: Parameters<typeof world.store.load>) => { await gate; return world.store.load(...args); },
        query: async (...args: Parameters<typeof world.store.query>) => { await gate; return world.store.query(...args); },
        outboxGet: async (id: string) => { await gate; return world.store.outboxGet(id); },
      };
      const command = defineSystemCommand({ name: 'test.pending-read', stage: () => ({}), read: (_args, ctx) => {
        pending = kind === 'load' ? ctx.load(world.model, 'absent' as never)
          : kind === 'query' ? ctx.query({ model: world.model, authority: 'owner', archived: 'include' })
          : readSystemCommandRetainedOutbox(ctx, 'absent');
        return null;
      } });
      await assert.rejects(createSystemRegistry([command]).read(command.name, {}, runCtx('pending-read'), { store }), /unawaited/);
      release(); await assert.rejects(pending, /crossed/);
      assert.equal(await world.store.readRevision(), revision);
    });
  }
  it('refuses commands without read behavior without invoking their stage', async () => {
    const world = await setupPortsWorld(); let stages = 0;
    const command = defineSystemCommand({ name: 'test.stage-only', stage: () => { stages++; return {}; } });
    await assert.rejects(createSystemRegistry([command]).read(command.name, {}, runCtx('stage-only'), { store: world.store }), /no read-only/);
    assert.equal(stages, 0); assert.equal(await world.store.readRevision(), 0);
  });
});
