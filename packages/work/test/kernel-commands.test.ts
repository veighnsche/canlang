/**
 * S9b-2: kernel command stages transition rows correctly through
 * hand-faked readers-only contexts. These tests prove MY stage logic
 * (ordering, refusals, conditional updates, idempotency); the L3
 * registry/commit behavior stays L3-tested. The installed preclaim guard
 * join additionally uses the actual registry and memory store below.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ClaimId,
  FrameworkFilePayloadOrigin,
  ModelName,
  OperationId,
  OperationName,
  QuerySpec,
  RecordId,
  RecordVersion,
  StoredRow,
} from '@canlang/contracts';
import { DELIVERY_RESULT_LEAVES } from '@canlang/contracts';
import { RECEIPT_MODEL, newReceiptRow, readReceiptRow } from '@canlang/state/receipt/tables';
import type {
  SystemCommandContext,
  SystemCommandDef,
  SystemStaging,
} from '@canlang/state';
import { createSystemRegistry, systemCommandStageRevision, enrollSystemCommandCommitCheck, StateError } from '@canlang/state';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import {
  WORK_DISPATCH_MODEL,
  WORK_EVERY_SLOT_MODEL,
  WORK_OCCURRENCE_MODEL,
  WORK_SCHEDULE_MODEL,
  WORK_SUPERSESSION_MODEL,
  newDispatchRow,
  newEverySlotRow,
  newOccurrenceRow,
  newScheduleRow,
  newSupersessionRow,
  readDispatchRow,
  readOccurrenceRow,
  readScheduleRow,
  readDispatchImageControlPin,
} from '../src/kernel/tables.js';
import { KernelTableError } from '../src/kernel/tables.js';
import {
  WORK_DISPATCH_STAGE_COMMANDS,
  createWorkDispatchClaimCommand,
  type DispatchClaimGuard,
  WORK_SYSTEM_COMMANDS,
  workDispatchClaimCommand,
  workDispatchStopPendingCommand,
  workDispatchPinImageControlCommand,
  workDispatchPinMailRecipientCommand,
  workDispatchRecordAttemptCommand,
  workDispatchRequeueCommand,
  workDispatchReleaseCommand,
  workDispatchSupersedeCommand,
  workEveryAdvanceSlotCommand,
  workOccurrencePutReceiptCommand,
  workScheduleCancelCommand,
  workSchedulePutCommand,
} from '../src/kernel/commands.js';
import {
  stageDueSchedule,
  workScheduleCancelCommand as portableScheduleCancelCommand,
  workSchedulePutCommand as portableSchedulePutCommand,
} from '@canlang/work/kernel/schedule-staging';
import { workOccurrencePutReceiptCommand as portableOccurrencePutReceiptCommand } from '@canlang/work/kernel/occurrence-staging';
import { RootRecurrenceNotSupportedError } from '../src/schedule/every.js';
import { commitOutboxIntent, stageOutboxIntent } from '../src/intent/index.js';
import {
  readDispatchGuardExecution, registerDispatchGuardRevalidation, runDispatchGuardPhase,
  transferDispatchGuardPhase, type DispatchGuardExecution, type DispatchGuardPhase,
} from '../src/dispatch/index.js';

const NOW = 1_758_000_000_000;
const ACTOR = 'dispatcher-test';
const MAX_AGE = 60_000;

// Persistence header fixture; State separately validates the installed source closure.
function opaqueHeader(model: ModelName, id: string, field: 'result' | 'payload'): FrameworkFilePayloadOrigin {
  return { version: 1, inventory: { owner: 'expense', snapshotId: 'original', digest: 'digest' },
    declarationSetId: 'original-declarations', slot: { model, id: id as RecordId, created: NOW, createdBy: ACTOR,
      field, role: field === 'result' ? 'retained-result' : 'deferred-input' }, scope: { ...SCOPE },
    origin: { kind: 'event-input', occurrenceId: id, sourceOccurrence: id,
      declaration: { kind: 'declared-event', source: { path: 'expense.can', sha256: 'source', module: 'expense' },
        event: 'expense.remind', inputsDeclarationId: 'event-inputs' },
      lineage: { kind: 'schedule', key: 'reminder', replaces: null }, target: { kind: 'schedule' } }, files: [] };
}

it('captures actual receipt result and origin before a held load, then rejects duplicate origin disagreement', async () => {
  const origin = opaqueHeader(WORK_OCCURRENCE_MODEL, 'held-receipt', 'result');
  const expected = structuredClone(origin);
  const result = { outputs: [{ ref: 'original-wire' }] };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ctx = fakeCtx(seed([]));
  const staging = runStage(workOccurrencePutReceiptCommand.stage, { occurrenceId: 'held-receipt',
    status: 'completed', result, filePayloadOrigin: origin, code: null, message: null },
    { ...ctx, load: async () => { await held; return null; } });
  result.outputs[0]!.ref = 'mutated';
  (origin.inventory as { snapshotId: string }).snapshotId = 'mutated';
  release();
  const write = (await staging).writes?.[0];
  if (write?.kind !== 'insert') throw new Error('missing insert');
  const persisted = structuredClone(write.row);
  assert.deepEqual(readOccurrenceRow(persisted).result, { outputs: [{ ref: 'original-wire' }] });
  assert.deepEqual(readOccurrenceRow(persisted).filePayloadOrigin, expected);
  const replay = fakeCtx(seed([{ model: WORK_OCCURRENCE_MODEL, row: persisted }]));
  const disagree = { ...expected, declarationSetId: 'replacement' };
  await assert.rejects(runStage(workOccurrencePutReceiptCommand.stage, { occurrenceId: 'held-receipt',
    status: 'completed', result: null, filePayloadOrigin: disagree }, replay), KernelTableError);
  assert.equal((await runStage(workOccurrencePutReceiptCommand.stage,
    { occurrenceId: 'held-receipt', status: 'completed' }, replay)).writes, undefined);
});

it('captures schedule payload and origin before a held query and preserves predecessor metadata through replacement and cancel', async () => {
  const original = opaqueHeader(WORK_SCHEDULE_MODEL, 'predecessor', 'payload');
  const predecessor = scheduleRow('predecessor', { filePayloadOrigin: original });
  const store = seed([{ model: WORK_SCHEDULE_MODEL, row: predecessor }]);
  const ctx = fakeCtx(store);
  const supplied = opaqueHeader(WORK_SCHEDULE_MODEL, 'next', 'payload');
  const expected = structuredClone(supplied);
  const payload = { nested: { file: 'original-wire' } };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const staging = runStage(workSchedulePutCommand.stage, { key: 'reminder', scope: SCOPE, at: NOW,
    event: 'expense.remind', occurrenceId: 'next', payload, filePayloadOrigin: supplied },
    { ...ctx, query: async spec => { await held; return ctx.query(spec); } });
  payload.nested.file = 'mutated';
  (supplied.inventory as { digest: string }).digest = 'mutated';
  release();
  const staged = await staging;
  const writes = staged.writes?.filter(write => write.model === WORK_SCHEDULE_MODEL) ?? [];
  assert.equal(writes.length, 2);
  for (const write of writes) {
    if (write.kind !== 'insert' && write.kind !== 'update') throw new Error('unexpected write');
    store.set(`${write.model}\0${write.row.id}`, structuredClone(write.row));
    const data = readScheduleRow(write.row);
    assert.deepEqual(data.filePayloadOrigin, write.row.id === 'next' ? expected : original);
    if (write.row.id === 'predecessor') assert.equal(data.state, 'superseded');
    else assert.deepEqual(data.payload, { nested: { file: 'original-wire' } });
  }
  const dueInput = { key: 'reminder', scope: SCOPE, at: NOW, event: 'expense.remind',
    occurrenceId: 'next', filePayloadOrigin: expected };
  const due = await stageDueSchedule(dueInput, ctx);
  if (due.status !== 'ready') throw new Error('missing due admission');
  assert.deepEqual(due.occurrence.filePayloadOrigin, expected);
  const dueWrite = due.effects.writes?.[0];
  if (dueWrite?.kind !== 'update') throw new Error('missing due update');
  assert.deepEqual(readScheduleRow(dueWrite.row).filePayloadOrigin, expected);
  await assert.rejects(stageDueSchedule({ ...dueInput,
    filePayloadOrigin: { ...expected, declarationSetId: 'disagreement' } }, ctx), KernelTableError);
  const cancelled = await runStage(workScheduleCancelCommand.stage, { key: 'reminder', scope: SCOPE }, ctx);
  const cancel = cancelled.writes?.find(write => write.model === WORK_SCHEDULE_MODEL);
  if (cancel?.kind !== 'update') throw new Error('missing cancel');
  assert.deepEqual(readScheduleRow(cancel.row).filePayloadOrigin, expected);
  assert.equal(readScheduleRow(cancel.row).state, 'cancelled');
  await assert.rejects(runStage(workSchedulePutCommand.stage, { key: 'reminder', scope: SCOPE, at: NOW,
    event: 'expense.remind', occurrenceId: 'next', payload: {},
    filePayloadOrigin: { ...expected, declarationSetId: 'disagreement' } }, ctx), KernelTableError);
});

const GENERATION_FAMILIES = [
  { name: 'Images', original: 'std.ImagesV1.submit', cancel: 'std.ImagesV1.cancel', reconcile: 'std.ImagesV1.reconcile',
    result: 'ImageRun', binding: 'Acme.Images', from: 'deployment.images', queued: { outputs: [], charged_jobs: null } },
  { name: 'TextGeneration', original: 'std.TextGenerationV1.generate', cancel: 'std.TextGenerationV1.cancel', reconcile: 'std.TextGenerationV1.reconcile',
    result: 'TextRun', binding: 'Acme.Text', from: 'deployment.llm', queued: { content: '', used_tokens: null } },
] as const;

function seed(
  entries: ReadonlyArray<{ model: ModelName; row: StoredRow }>,
): Map<string, StoredRow> {
  const map = new Map<string, StoredRow>();
  for (const entry of entries) {
    map.set(`${entry.model}\0${entry.row.id}`, entry.row);
  }
  return map;
}

function fakeCtx(store: Map<string, StoredRow>): SystemCommandContext {
  return {
    actor: ACTOR,
    now: NOW,
    operation: 'test.dispatch',
    load: async (model: ModelName, id: RecordId) =>
      store.get(`${model}\0${id}`) ?? null,
    // Deliberately unfiltered: stages must re-filter exactly, and the
    // decoy rows below prove it.
    query: async (spec: QuerySpec) =>
      [...store.entries()]
        .filter(([key]) => key.startsWith(`${spec.model}\0`))
        .map(([, row]) => row),
  };
}

/**
 * Run one stage as a genuine promise. Stages may return sync or async
 * per `SystemCommandDef`; `Promise.resolve` adopts either (and any
 * rejection), which is what `assert.rejects` needs.
 */
function runStage(
  stage: SystemCommandDef['stage'],
  args: Record<string, unknown>,
  ctx: SystemCommandContext,
): Promise<SystemStaging> {
  return Promise.resolve(stage(args, ctx));
}

function dispatchRow(
  intentId: string,
  over: Record<string, unknown> = {},
): StoredRow {
  const base = newDispatchRow(
    {
      intentId,
      operationId: 'op_1',
      source: 'std.EmailV1.send',
      occurrenceIndex: 0,
      originOccurrence: 'occ_9',
    },
    { nowMs: NOW, actor: ACTOR },
  );
  return { ...base, data: { ...readDispatchRow(base), ...over } };
}

describe('kernel commands: registry shape', () => {
  it('exports 12 uniquely named dot-namespaced commands', () => {
    assert.equal(WORK_SYSTEM_COMMANDS.length, 12);
    assert.equal(portableSchedulePutCommand, workSchedulePutCommand);
    assert.equal(portableScheduleCancelCommand, workScheduleCancelCommand);
    assert.ok(WORK_SYSTEM_COMMANDS.includes(portableSchedulePutCommand));
    assert.ok(WORK_SYSTEM_COMMANDS.includes(portableScheduleCancelCommand));
    const names = WORK_SYSTEM_COMMANDS.map((command) => command.name);
    assert.equal(new Set(names).size, 12);
    for (const name of names) {
      assert.match(name, /^work\.[a-z-]+\.[a-z-]+$/);
    }
    // T24b attribution: the worker assembly composes the staging join
    // alongside (`[...l3Commands, ...WORK_SYSTEM_COMMANDS,
    // ...WORK_DISPATCH_STAGE_COMMANDS]` — the composition helper lives
    // worker-side in `assembly.ts`), so the composed work-side shape is
    // 14 uniquely named commands including Images pending stop/control pin.
    const composed = [...WORK_SYSTEM_COMMANDS, ...WORK_DISPATCH_STAGE_COMMANDS];
    assert.equal(composed.length, 14);
    const composedNames = composed.map((command) => command.name);
    assert.equal(new Set(composedNames).size, 14);
    for (const name of composedNames) {
      assert.match(name, /^work\.[a-z-]+\.[a-z-]+$/);
    }
  });
});

describe('composed Work registry bounded own JSON admission', () => {
  const commands = [...WORK_SYSTEM_COMMANDS, ...WORK_DISPATCH_STAGE_COMMANDS];
  const context = { actor: ACTOR, now: NOW, operation: 'test.bounded', operationId: 'bounded-run' };
  const scheduleArgs = (payload: unknown): Record<string, unknown> => ({
    key: 'reminder', scope: { app: 'A', owner: 'team', ownerPackage: 'A' },
    at: NOW + 1000, event: 'A.due', payload, occurrenceId: 'occ',
  });
  const expectRefusal = async (args: unknown, code: 'validation' | 'limit', names = commands.map(command => command.name)) => {
    for (const name of names) {
      const { store, probe } = createTestMemoryStorage();
      let reads = 0, commits = 0;
      const guarded = { ...store,
        readRevision: async () => { reads++; return store.readRevision(); },
        load: async (...input: Parameters<typeof store.load>) => { reads++; return store.load(...input); },
        query: async (...input: Parameters<typeof store.query>) => { reads++; return store.query(...input); },
        commit: async (...input: Parameters<typeof store.commit>) => { commits++; return store.commit(...input); },
      };
      await assert.rejects(createSystemRegistry(commands).run(name, args,
        { ...context, operationId: '' }, { store: guarded }), error => {
        assert.ok(error instanceof StateError); assert.equal(error.code, code);
        if (code === 'limit') assert.equal(error.retryable, false);
        assert.match(error.message, /Work command args/); return true;
      });
      assert.equal(reads, 0, name); assert.equal(commits, 0, name);
      assert.equal(await store.readRevision(), 0);
      assert.deepEqual(probe.outboxAll(), []); assert.equal(probe.scheduleGet('A/A/team/reminder'), null);
    }
  };
  const admitSchedule = async (payload: unknown) => {
    const { store, probe } = createTestMemoryStorage();
    await createSystemRegistry(commands).run('work.schedule.put', scheduleArgs(payload), context, { store });
    assert.equal(await store.readRevision(), 1);
    assert.deepEqual(probe.scheduleGet('A/A/team/reminder')!.payload, payload);
    return store;
  };
  it('admits reachable exact visits, text and depth; refuses each one over before any effects', async () => {
    // Root + six fields + three scope fields + nested array = eleven visits.
    await admitSchedule({ value: Array(19_989).fill(null) });
    await expectRefusal(scheduleArgs({ value: Array(19_990).fill(null) }), 'limit');
    const base = scheduleArgs({ value: '' });
    const scope = base['scope'] as Record<string, string>;
    const textOverhead = Object.keys(base).reduce((sum, key) => sum + key.length, 0)
      + ['key', 'event', 'occurrenceId'].reduce((sum, key) => sum + (base[key] as string).length, 0)
      + Object.entries(scope).reduce((sum, [key, value]) => sum + key.length + value.length, 0) + 'value'.length;
    await admitSchedule({ value: 'x'.repeat(2_000_000 - textOverhead) });
    await expectRefusal(scheduleArgs({ value: 'x'.repeat(2_000_001 - textOverhead) }), 'limit');
    let depth: unknown = null;
    for (let i = 0; i < 31; i++) depth = { v: depth };
    await admitSchedule(depth);
    await expectRefusal(scheduleArgs({ v: depth }), 'limit');
    const shared = Array(10_000).fill(null);
    await expectRefusal({ left: shared, right: shared }, 'limit');
  });
  it('refuses exotic own data across all fourteen actual commands without invoking getters or toJSON', async () => {
    let calls = 0;
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; return 1; } });
    const inherited = Object.create({ value: 1 });
    const hidden = Object.defineProperty({}, 'value', { value: 1 });
    const symbol = { [Symbol('value')]: 1 };
    const extra = Object.assign([1], { extra: 1 });
    const arrayGetter = Object.defineProperty([1], '0', { enumerable: true, get() { calls++; return 1; } });
    const cyclic: Record<string, unknown> = {}; cyclic['self'] = cyclic;
    for (const value of [getter, inherited, hidden, symbol, extra, arrayGetter, Array(1), cyclic,
      new Date(0), new Map(), { value: undefined }, { value: Symbol('x') }, { value: () => 1 },
      { value: NaN }, { value: Infinity }, { value: 1n }, { toJSON() { calls++; return {}; } }]) {
      await expectRefusal({ value }, 'validation');
    }
    assert.equal(calls, 0);
  });
  it('charges captured array-index keys at the combined array and string text boundary', async () => {
    const array = Array(1000).fill(null);
    const base = scheduleArgs({ array, value: '' });
    const scope = base['scope'] as Record<string, string>;
    const textOverhead = Object.keys(base).reduce((sum, key) => sum + key.length, 0)
      + ['key', 'event', 'occurrenceId'].reduce((sum, key) => sum + (base[key] as string).length, 0)
      + Object.entries(scope).reduce((sum, [key, value]) => sum + key.length + value.length, 0)
      + 'array'.length + 'value'.length
      + array.reduce((sum, _, index) => sum + String(index).length, 0);
    await admitSchedule({ array, value: 'x'.repeat(2_000_000 - textOverhead) });
    await expectRefusal(scheduleArgs({ array, value: 'x'.repeat(2_000_001 - textOverhead) }), 'limit');
  });
  it('detaches null-prototype payloads and shared raw aliases before asynchronous real schedule reads', async () => {
    const { store, probe } = createTestMemoryStorage();
    const shared = Object.assign(Object.create(null) as Record<string, unknown>, { value: -0, text: '\uD800' });
    const payload = { left: shared, explicit: null, list: [false, 1] };
    let queries = 0;
    const inspected = commands.map(command => command !== workSchedulePutCommand ? command : {
      ...command, stage: (args: Readonly<Record<string, unknown>>, ctx: SystemCommandContext) => {
        const cloned = args['payload'] as typeof payload;
        assert.ok(Object.is(cloned.left['value'], -0)); assert.equal(cloned.left, args['alias']);
        return command.stage(args, ctx);
      },
    });
    // Work's existing table validator rejects repeated payload aliases. Keep
    // this raw alias outside the stored payload to preserve that later refusal.
    await createSystemRegistry(inspected).run('work.schedule.put', { ...scheduleArgs(payload), alias: shared }, context, { store: {
      ...store, query: async spec => { queries++; shared['text'] = 'changed'; payload.list[0] = true; return store.query(spec); },
    } });
    assert.ok(queries > 0);
    const captured = probe.scheduleGet('A/A/team/reminder')!.payload as typeof payload;
    assert.equal(captured.left['text'], '\uD800');
    assert.equal(captured.left['value'], 0, 'existing JSON storage normalizes negative zero');
    assert.deepEqual(captured.list, [false, 1]); assert.equal(captured.explicit, null);
    assert.equal(Object.hasOwn(captured, 'absent'), false);
  });
  it('keeps unknown-command lookup ahead of hostile args and leaves unrelated command clone behavior unchanged', async () => {
    const { store } = createTestMemoryStorage();
    let calls = 0;
    const args = Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; return 'legacy'; } });
    await assert.rejects(createSystemRegistry(commands).run('work.unknown', args, context, { store }),
      error => error instanceof StateError && error.code === 'validation' && /Unknown system command/.test(error.message));
    assert.equal(calls, 0);
    const legacy: SystemCommandDef = { name: 'operator.legacy', stage: captured => ({ result: captured['value'] }) };
    const outcome = await createSystemRegistry([legacy]).run(legacy.name, args, context, { store });
    assert.equal(calls, 1); assert.equal(outcome.result, 'legacy');
  });
});

for (const family of GENERATION_FAMILIES) describe(`kernel commands: ${family.name} dispatch.pin-image-control`, () => {
  const correlation = { requestSource: 'Acme.Draft.poster', requestRevision: '3',
    requestBinding: family.binding, requestFrom: family.from, requestApp: 'Acme', requestOwner: 'team-1' };
  const originalIntentId = 'original-image';
  const original = dispatchRow(originalIntentId, { source: family.original, ...correlation });
  const control = (over: Record<string, unknown> = {}) => dispatchRow('control-image', {
    source: family.cancel, state: 'claimed', claimId: 'control-claim', claimedAtMs: NOW,
    ...correlation, ...over,
  });
  const args = { intentId: 'control-image', claimId: 'control-claim', originalIntentId, correlation,
    observation: { startedAtMs: NOW, deadlineMs: NOW + 1000 } };
  const ctx = (row = control(), submit = original) => fakeCtx(seed([
    { model: WORK_DISPATCH_MODEL, row }, { model: WORK_DISPATCH_MODEL, row: submit },
  ]));

  it('pins the exact original and fixed window under either real control claim, then preserves serialized expired replay', async () => {
    for (const source of [family.cancel, family.reconcile]) {
      const row = control({ source });
      const staged = await runStage(workDispatchPinImageControlCommand.stage, args, ctx(row));
      assert.equal(staged.writes?.length, 1);
      const write = staged.writes![0]!; assert.equal(write.kind, 'update');
      if (write.kind !== 'update') return;
      assert.equal(write.expectedVersion, row.version);
      const pin = { originalIntentId, observationStartedAtMs: NOW, observationDeadlineMs: NOW + 1000 };
      assert.deepEqual(readDispatchImageControlPin(readDispatchRow(write.row)), pin);
      assert.deepEqual(readDispatchRow(write.row), { ...readDispatchRow(row), ...pin });
      assert.equal(staged.outboxAck, undefined);
      const replay = await runStage(workDispatchPinImageControlCommand.stage, args, { ...ctx(JSON.parse(JSON.stringify(write.row)) as StoredRow), now: NOW + 2000 });
      assert.equal(replay.writes, undefined);
      assert.deepEqual(replay.result, { pinned: true, existing: true, intentId: row.id, ...pin });
      await assert.rejects(runStage(workDispatchPinImageControlCommand.stage, {
        ...args, observation: { startedAtMs: NOW, deadlineMs: NOW + 2000 },
      }, ctx(write.row)), /cannot be renewed/);
      const replacement = dispatchRow('another-original', { source: family.original, ...correlation });
      await assert.rejects(runStage(workDispatchPinImageControlCommand.stage, {
        ...args, originalIntentId: replacement.id,
      }, ctx(write.row, replacement)), /cannot be renewed or replaced/);
    }
  });

  it('refuses another generation family even with identical retained correlation', async () => {
    const foreign = GENERATION_FAMILIES.find(other => other.name !== family.name)!;
    const otherOriginal = dispatchRow(originalIntentId, { source: foreign.original, ...correlation });
    await assert.rejects(runStage(workDispatchPinImageControlCommand.stage, args, ctx(control(), otherOriginal)), /identities and correlation disagree/);
    const staged = await runStage(workDispatchPinImageControlCommand.stage, args, ctx());
    const pinned = staged.writes![0]!; assert.ok(pinned.kind === 'update');
    // A persisted pin cannot be replayed after its original target changes family.
    await assert.rejects(runStage(workDispatchPinImageControlCommand.stage, args, ctx(pinned.row, otherOriginal)), /identities and correlation disagree/);
  });

  it('refuses foreign correlation, identity, claim, malformed/future/expired or over-cap windows without writes', async () => {
    for (const field of Object.keys(correlation) as Array<keyof typeof correlation>) {
      const altered = { ...correlation, [field]: field === 'requestRevision' ? '4' : 'different' };
      await assert.rejects(runStage(workDispatchPinImageControlCommand.stage, { ...args, correlation: altered }, ctx()), /identities and correlation disagree/);
    }
    for (const over of [{ claimId: 'lost' }, { state: 'pending' }, { source: family.original },
      { intentId: 'foreign' }, { claimedAtMs: null }, { requestOwner: 'foreign' }]) {
      await assert.rejects(runStage(workDispatchPinImageControlCommand.stage, args, ctx(control(over))));
    }
    await assert.rejects(runStage(workDispatchPinImageControlCommand.stage, args,
      ctx(control(), dispatchRow(originalIntentId, { ...correlation, source: family.reconcile }))));
    for (const observation of [{ startedAtMs: NOW + 1, deadlineMs: NOW + 1000 },
      { startedAtMs: NOW, deadlineMs: NOW }, { startedAtMs: NOW, deadlineMs: Infinity },
      { startedAtMs: NOW, deadlineMs: NOW + 2_147_483_648 },
      { startedAtMs: NOW, deadlineMs: NOW + 1000, extra: true },
      Object.defineProperty({ deadlineMs: NOW + 1000 }, 'startedAtMs', { get: () => { throw new Error('getter must not run'); } })]) {
      await assert.rejects(runStage(workDispatchPinImageControlCommand.stage, { ...args, observation }, ctx()), KernelTableError);
    }
    await assert.rejects(runStage(workDispatchPinImageControlCommand.stage, {
      ...args, originalIntentId: 'missing-original',
    }, ctx()));
    assert.throws(() => readDispatchRow(control({ originalIntentId })), /Incomplete/);
  });
});

for (const family of GENERATION_FAMILIES) describe(`kernel commands: ${family.name} dispatch.stop-pending`, () => {
  const intentId = 'op_images#0';
  const correlation = { requestSource: 'Acme.Draft.poster', requestRevision: '3',
    requestBinding: family.binding, requestFrom: family.from, requestApp: 'Acme', requestOwner: 'team-1' };
  const context = { source: family.original,
    declaredResult: { name: family.result, fields: DELIVERY_RESULT_LEAVES[family.result]! },
    request: { source: correlation.requestSource, revision: correlation.requestRevision } };
  const args = { intentId, correlation, revision: 10 };
  const original = (over: Record<string, unknown> = {}) => dispatchRow(intentId, {
    source: context.source, ...correlation, ...over,
  });
  const receipt = (over: Record<string, unknown> = {}) => {
    const row = newReceiptRow({ deliveryId: intentId, revision: 4, status: 'pending',
      result: null, error: null, contentRef: null, resultExpiresAtMs: null }, { nowMs: NOW, actor: ACTOR });
    return { ...row, data: { ...row.data, ...over } };
  };
  const ctx = (row: StoredRow, retained = receipt()) => fakeCtx(seed([
    { model: WORK_DISPATCH_MODEL, row }, { model: RECEIPT_MODEL as ModelName, row: retained },
  ]));

  it('stages pending and currently claimed original skips with exact versions and preserved origin/correlation', async () => {
    for (const state of ['pending', 'claimed']) {
      const row = original({ state, ...(state === 'claimed' ? { claimId: 'provider-claim', claimedAtMs: NOW } : {}) });
      const retained = receipt();
      const staged = await runStage(workDispatchStopPendingCommand.stage, args, ctx(row, retained));
      assert.deepEqual(staged.result, { stopped: true, intentId, receiptRevision: 10 });
      assert.deepEqual(staged.outboxAck, [intentId]);
      assert.equal(staged.writes?.length, 2);
      const dispatch = staged.writes![0]!; const skipped = staged.writes![1]!;
      assert.equal(dispatch.kind, 'update'); assert.equal(skipped.kind, 'update');
      if (dispatch.kind !== 'update' || skipped.kind !== 'update') return;
      assert.equal(dispatch.expectedVersion, row.version);
      assert.equal(skipped.expectedVersion, retained.version);
      assert.deepEqual(readDispatchRow(dispatch.row), { ...readDispatchRow(row),
        state: 'pending', guardVerdict: false, claimId: null, claimedAtMs: null });
      assert.deepEqual(readReceiptRow(skipped.row, context).receipt, {
        deliveryId: intentId, revision: 10, status: 'skipped', result: null, error: null,
      });
      const replay = await runStage(workDispatchStopPendingCommand.stage, args, ctx(dispatch.row, skipped.row));
      assert.equal((replay.result as { reason: string }).reason, 'already-stopped');
      assert.equal(replay.writes, undefined); assert.equal(replay.outboxAck, undefined);
      await assert.rejects(runStage(workDispatchRecordAttemptCommand.stage, {
        intentId, claimId: 'provider-claim', outcome: { state: 'delivered' }, ack: true,
      }, ctx(dispatch.row, skipped.row)), /does not hold/);
    }
  });

  it('never skips actual queued progress, terminal receipts, settled dispatches or an earlier attempt', async () => {
    const queued = { source: correlation.requestSource, revision: '3',
      state: 'queued', ...family.queued, detail: null, sequence: '0' };
    for (const [row, retained, reason] of [
      [original({ state: 'claimed', claimId: 'provider-claim', claimedAtMs: NOW }), receipt({ result: queued }), 'receipt-started'],
      [original(), receipt({ status: 'succeeded' }), 'receipt-settled'],
      [original({ state: 'delivered' }), receipt(), 'settled'],
      [original({ attempts: 1, firstAttemptAtMs: NOW }), receipt(), 'attempted'],
    ] as const) {
      const staged = await runStage(workDispatchStopPendingCommand.stage, args, ctx(row, retained));
      assert.equal((staged.result as { stopped: boolean; reason: string }).stopped, false);
      assert.equal((staged.result as { reason: string }).reason, reason);
      assert.equal(staged.writes, undefined); assert.equal(staged.outboxAck, undefined);
    }
  });

  it('refuses another family typed progress rather than treating it as an untouched receipt', async () => {
    const foreign = GENERATION_FAMILIES.find(other => other.name !== family.name)!;
    const result = { source: correlation.requestSource, revision: correlation.requestRevision,
      state: 'queued', sequence: '0', detail: null, ...foreign.queued };
    await assert.rejects(runStage(workDispatchStopPendingCommand.stage, args, ctx(original(), receipt({ result }))));
    for (const missing of ['result', 'error']) {
      const retained = receipt(); const data = { ...retained.data }; delete data[missing];
      await assert.rejects(runStage(workDispatchStopPendingCommand.stage, args, ctx(original(), { ...retained, data })), /retain result and error explicitly/);
    }
  });

  it('refuses malformed original identity, correlation, receipt and checkpoints without stages', async () => {
    for (const over of [{ source: family.cancel }, { requestOwner: 'foreign' },
      { requestRevision: '03' }, { intentId: 'different' }, { state: 'claimed' }]) {
      await assert.rejects(runStage(workDispatchStopPendingCommand.stage, args, ctx(original(over))));
    }
    for (const over of [{ deliveryId: 'different' }, { error: { code: 'failed', message: 'failed' } },
      { result: { state: 'queued' } }, { result: undefined }, { contentRef: 'content' }]) {
      await assert.rejects(runStage(workDispatchStopPendingCommand.stage, args, ctx(original(), receipt(over))));
    }
    for (const over of [{ revision: 4 }, { revision: Infinity }, { revision: 1.5 },
      { correlation: { ...correlation, extra: 'unexpected' } }, { correlation: { ...correlation, requestApp: 'foreign' } },
      { extra: true }]) {
      await assert.rejects(runStage(workDispatchStopPendingCommand.stage, { ...args, ...over }, ctx(original())));
    }
    await assert.rejects(runStage(workDispatchStopPendingCommand.stage, args, fakeCtx(seed([]))));
    await assert.rejects(runStage(workDispatchStopPendingCommand.stage, args,
      fakeCtx(seed([{ model: WORK_DISPATCH_MODEL, row: original() }]))));
  });
});

describe('installed dispatch guard joins the actual original registry commit (memory only)', () => {
  const allocateClaim = () => 'allocated-claim' as ClaimId;
  async function fixture(over: Record<string, unknown> = {}, superseded = false,
    allocator?: () => ClaimId) {
    const { store, probe } = createTestMemoryStorage();
    const staged = stageOutboxIntent({ operationId: '0193f2c0-0000-7000-8000-000000000003',
      source: 'std.EmailV1.send', occurrenceIndex: 0, request: { to: 'a@example.com' },
      originOccurrence: null });
    const row = newDispatchRow({ intentId: staged.item.id, operationId: staged.item.operationId,
      source: staged.item.source, occurrenceIndex: staged.item.occurrenceIndex,
      originOccurrence: staged.item.originOccurrence }, { nowMs: NOW, actor: ACTOR });
    const seeded = { ...row, data: { ...row.data, ...over } };
    const committed = await store.commit({ expectedRevision: await store.readRevision(),
      writes: [{ kind: 'insert', model: WORK_DISPATCH_MODEL, row: seeded }, ...(superseded ? [{
        kind: 'insert' as const, model: WORK_SUPERSESSION_MODEL,
        row: newSupersessionRow({ outboxId: staged.item.id, byOccurrenceId: 'occ_1', markedAtMs: NOW },
          { nowMs: NOW, actor: ACTOR }),
      }] : [])], history: [], receipt: null, schedules: [], uniqueClaims: [], uniqueReleases: [],
      outbox: [{ intentId: staged.item.id, operation: 'Acme.send' as OperationName,
        operationId: staged.item.operationId as OperationId, target: staged.item.source,
        arguments: staged.item.request, occurrenceIndex: staged.item.occurrenceIndex }] });
    // Unit intent model names the actual committed seed revision. Native lexical
    // and commit-marker issuance remain Dev's separate source-adapter prerequisite.
    const intent = commitOutboxIntent(staged, { revision: committed.revision, committedAtMs: NOW });
    const originalOutbox = await store.outboxGet(staged.item.id);
    const originalOutboxIntents = probe.outboxAll();
    const run = (guard: DispatchClaimGuard | undefined, availability = () => true,
      extraArgs: Record<string, unknown> = {}) =>
      createSystemRegistry([createWorkDispatchClaimCommand(availability, guard, allocator)]).run('work.dispatch.claim', {
        intentId: staged.item.id, ...(allocator === undefined ? { claimId: 'new-claim' } : {}),
        claimedAtMs: NOW, maxClaimAgeMs: MAX_AGE, ...extraArgs,
      }, { actor: ACTOR, now: NOW, operation: 'test.claim', operationId: 'claim-run' }, { store });
    return { store, intent, row: seeded, revision: committed.revision, run,
      async unchanged(expectedRevision = committed.revision) {
        assert.equal(await store.readRevision(), expectedRevision);
        assert.deepEqual(await store.load(WORK_DISPATCH_MODEL, staged.item.id as RecordId), seeded);
        assert.deepEqual(await store.outboxGet(staged.item.id), originalOutbox);
        assert.deepEqual(probe.historyFor(WORK_DISPATCH_MODEL, staged.item.id as RecordId), []);
        assert.deepEqual(probe.outboxAll(), originalOutboxIntents);
      },
      current: () => store.load(WORK_DISPATCH_MODEL, staged.item.id as RecordId) };
  }

  for (const installed of [false, true]) for (const stale of [false, true]) for (const result of [false, true]) {
    it(`${installed ? 'allocated' : 'explicit'} ${stale ? 'stale reclaim' : 'pending'} ${result ? 'claims' : 'skips without claim or attempt'} after closed evidence and authority`, async () => {
      let allocations = 0; const order: string[] = [];
      const f = await fixture(stale ? { state: 'claimed', claimId: 'old', claimedAtMs: NOW - MAX_AGE,
        attempts: 2, firstAttemptAtMs: NOW - MAX_AGE * 2 } : {}, false, installed ? () => {
        allocations++; order.push('allocate'); return allocateClaim();
      } : undefined);
      let execution!: DispatchGuardExecution, context!: SystemCommandContext;
      let sourceCalls = 0, observationChecks = 0, authorityChecks = 0;
      const outcome = await f.run(async input => {
        context = input.context;
        assert.equal(input.revision, f.revision);
        assert.equal(systemCommandStageRevision(context), f.revision);
        assert.ok(Object.isFrozen(input)); assert.ok(Object.isFrozen(input.row));
        assert.ok(Object.isFrozen(input.row.data)); assert.ok(Object.isFrozen(input.data));
        assert.deepEqual(input.row, f.row);
        assert.throws(() => { (input.data as unknown as Record<string, unknown>).source = 'foreign'; }, TypeError);
        const phase = await runDispatchGuardPhase({ stage: input.context, predicate: 'current.membership', frozenInputs: { user: 'u1' },
          stateSnapshot: input.row, checkpoint: { revision: input.revision, owner: 'team-1' }, intent: f.intent,
          evaluateGuard: (_predicate, _inputs, _snapshot, issued) => {
            execution = issued; sourceCalls++; order.push('evaluate');
            registerDispatchGuardRevalidation(issued, async () => {
              observationChecks++;
              assert.equal(await f.store.readRevision(), input.revision);
              assert.deepEqual(await f.current(), f.row);
              return true;
            });
            return result;
          } });
        return { phase, async currentAuthority(this: { readonly phase: DispatchGuardPhase }) {
          assert.equal(this.phase, phase);
          authorityChecks++; assert.equal(await f.store.readRevision(), input.revision);
          assert.deepEqual(await f.current(), f.row); return true;
        } };
      });
      assert.equal(outcome.revision, f.revision + 1);
      assert.equal(sourceCalls, 1); assert.equal(observationChecks, 1); assert.equal(authorityChecks, 1);
      assert.equal(allocations, installed && result ? 1 : 0);
      assert.deepEqual(order, installed && result ? ['evaluate', 'allocate'] : ['evaluate']);
      assert.throws(() => readDispatchGuardExecution(execution), /not live/);
      assert.throws(() => systemCommandStageRevision(context), /./);
      assert.throws(() => enrollSystemCommandCommitCheck(context, () => true), /./);
      const current = await f.current(); assert.ok(current);
      const data = readDispatchRow(current);
      assert.equal(current.version, f.row.version + 1);
      assert.equal(data.attempts, stale ? 2 : 0);
      assert.equal(data.firstAttemptAtMs, stale ? NOW - MAX_AGE * 2 : null);
      const retained = await f.store.outboxGet(f.intent.item.id); assert.ok(retained);
      if (result) {
        assert.deepEqual(outcome.result, { claimed: true, ...(stale ? { reclaimed: true } : {}),
          intentId: f.intent.item.id, claimId: installed ? allocateClaim() : 'new-claim' });
        assert.equal(data.state, 'claimed'); assert.equal(data.claimId, installed ? allocateClaim() : 'new-claim');
        assert.equal(data.claimedAtMs, NOW); assert.equal(retained.status, 'pending');
      } else {
        assert.deepEqual(outcome.result, { claimed: false, reason: 'guard-false', intentId: f.intent.item.id });
        assert.equal(data.state, 'pending'); assert.equal(data.guardVerdict, false);
        assert.equal(data.claimId, null); assert.equal(data.claimedAtMs, null);
        assert.equal(retained.status, 'dispatched');
      }
    });
  }

  it('rejects nonfunction allocators at installation', () => {
    for (const invalid of [null, 'claim', 1, {}, Promise.resolve('claim')]) {
      assert.throws(() => createWorkDispatchClaimCommand(undefined, undefined,
        invalid as unknown as () => ClaimId), /allocator.*function/);
    }
  });

  it('refuses an explicit own claimId with an installed allocator before guard or allocation', async () => {
    for (const claimId of ['explicit', undefined, null]) {
      let guards = 0, allocations = 0;
      const f = await fixture({}, false, () => { allocations++; return allocateClaim(); });
      await assert.rejects(f.run(() => { guards++; throw new Error('ambiguous guard entered'); },
        () => true, { claimId }), error => {
        if (claimId === undefined) {
          // The released own-JSON boundary refuses an explicit undefined
          // before entering the existing claim ownership check.
          assert.ok(error instanceof StateError); assert.equal(error.code, 'validation');
          assert.equal(error.message, 'Work command args must be own finite JSON data.');
        } else {
          assert.match(String(error), /claimId must be omitted/);
        }
        return true;
      });
      assert.equal(guards, 0); assert.equal(allocations, 0); await f.unchanged();
    }
  });

  it('rejects an own claimId accessor without reading it or allocating', async () => {
    let reads = 0, allocations = 0;
    const command = createWorkDispatchClaimCommand(undefined, undefined, () => {
      allocations++; return allocateClaim();
    });
    const args = Object.defineProperty({ intentId: 'op_1#0', claimedAtMs: NOW, maxClaimAgeMs: MAX_AGE },
      'claimId', { get() { reads++; throw new Error('claimId getter entered'); } });
    await assert.rejects(runStage(command.stage, args, fakeCtx(seed([]))), /claimId must be omitted/);
    assert.equal(reads, 0); assert.equal(allocations, 0);
  });

  it('allocates exactly once for an eligible claim without an installed guard', async () => {
    let allocations = 0;
    const f = await fixture({}, false, () => { allocations++; return allocateClaim(); });
    const outcome = await f.run(undefined);
    assert.equal(allocations, 1); assert.equal(outcome.revision, f.revision + 1);
    assert.deepEqual(outcome.result, { claimed: true, intentId: f.intent.item.id, claimId: allocateClaim() });
    const row = await f.current(); assert.ok(row);
    assert.equal(readDispatchRow(row).claimId, allocateClaim());
    assert.equal((await f.store.outboxGet(f.intent.item.id))?.status, 'pending');
  });

  it('refuses invalid or throwing allocator results after the actual true guard without effects', async () => {
    for (const stale of [false, true]) for (const invalid of ['', 7, Promise.resolve('claim'), 'throw']) {
      let evaluations = 0, allocations = 0;
      const order: string[] = [];
      const f = await fixture(stale ? { state: 'claimed', claimId: 'old', claimedAtMs: NOW - MAX_AGE,
        attempts: 2, firstAttemptAtMs: NOW - MAX_AGE * 2 } : {}, false, () => {
        allocations++; order.push('allocate');
        if (invalid === 'throw') throw new Error('allocation failed');
        return invalid as unknown as ClaimId;
      });
      await assert.rejects(f.run(async input => ({
        phase: await runDispatchGuardPhase({ stage: input.context, predicate: 'current.membership', frozenInputs: {},
          stateSnapshot: input.row, checkpoint: { revision: input.revision, owner: 'team-1' }, intent: f.intent,
          evaluateGuard: () => { evaluations++; order.push('evaluate'); return true; } }),
        currentAuthority: () => true,
      })));
      assert.equal(evaluations, 1); assert.equal(allocations, 1);
      assert.deepEqual(order, ['evaluate', 'allocate']); await f.unchanged();
    }
  });

  it('does not allocate IDs or execute guards for superseded, pinned, deferred, held, settled or unavailable rows', async () => {
    for (const [over, marked, available, reason] of [
      [{}, true, true, 'superseded'], [{ guardVerdict: false }, false, true, 'guard-false'],
      [{ availableAtMs: NOW + 1 }, false, true, 'deferred'],
      [{ state: 'claimed', claimId: 'held', claimedAtMs: NOW }, false, true, 'claimed'],
      [{ state: 'delivered' }, false, true, 'settled'], [{}, false, false, 'unavailable'],
      [{ state: 'claimed', claimId: 'old', claimedAtMs: NOW - MAX_AGE }, false, false, 'unavailable'],
    ] as const) {
      let guards = 0, allocations = 0;
      const f = await fixture(over, marked, () => { allocations++; return allocateClaim(); });
      const outcome = await f.run(() => { guards++; throw new Error('ineligible source executed'); }, () => available);
      assert.equal((outcome.result as { reason: string }).reason, reason);
      assert.equal(guards, 0); assert.equal(allocations, 0);
      // The registry preserves its ordinary empty-commit revision advance.
      assert.equal(outcome.revision, f.revision + 1); await f.unchanged(outcome.revision);
    }
  });

  for (const result of [true, false]) for (const failure of ['observation', 'authority', 'nonboolean', 'reader', 'unknown-source']) {
    it(`refuses ${result ? 'claim' : 'skip'} when ${failure} fails before the original commit`, async () => {
      const f = await fixture({}, false, allocateClaim); let evaluated = 0;
      await assert.rejects(f.run(async input => ({
        phase: await runDispatchGuardPhase({ stage: input.context, predicate: 'current.membership', frozenInputs: {},
          stateSnapshot: input.row, checkpoint: { revision: input.revision, owner: 'team-1' }, intent: f.intent,
          evaluateGuard: (_predicate, _inputs, _snapshot, execution) => {
            evaluated++;
            registerDispatchGuardRevalidation(execution, () => {
              if (failure === 'reader') throw new Error('reader failure');
              return failure !== 'observation';
            });
            return failure === 'unknown-source' ? 'true' as unknown as boolean : result;
          } }),
        currentAuthority: () => failure === 'nonboolean' ? 'true' as unknown as boolean : failure !== 'authority',
      })));
      assert.equal(evaluated, 1); await f.unchanged();
    });
  }

  it('refuses forged/copied/consumed phases and mismatched original identities or checkpoints', async () => {
    for (const misuse of ['forged', 'copied', 'consumed', 'wrong-revision', 'wrong-id', 'wrong-source', 'wrong-operation',
      'absent-commit', 'staged-commit', 'future-commit', 'zero-commit', 'fractional-commit',
      'negative-time', 'missing-time', 'string-time', 'missing-commit-revision']) {
      const f = await fixture({}, false, allocateClaim);
      await assert.rejects(f.run(async input => {
        const candidate: Record<string, unknown> = { ...f.intent, item: { ...f.intent.item,
          ...(misuse === 'wrong-id' ? { id: 'foreign' } : {}),
          ...(misuse === 'wrong-source' ? { source: 'std.Other.send' } : {}),
          ...(misuse === 'wrong-operation' ? { operationId: 'foreign' } : {}) } };
        if (misuse === 'absent-commit') delete candidate.commit;
        if (misuse === 'staged-commit') candidate.commit = null;
        if (misuse === 'future-commit') candidate.commit = { ...f.intent.commit, revision: input.revision + 1 };
        if (misuse === 'zero-commit') candidate.commit = { ...f.intent.commit, revision: 0 };
        if (misuse === 'fractional-commit') candidate.commit = { ...f.intent.commit, revision: 1.5 };
        if (misuse === 'negative-time') candidate.commit = { ...f.intent.commit, committedAtMs: -1 };
        if (misuse === 'missing-time') candidate.commit = { revision: f.intent.commit.revision };
        if (misuse === 'string-time') candidate.commit = { ...f.intent.commit, committedAtMs: '0' };
        if (misuse === 'missing-commit-revision') candidate.commit = { committedAtMs: NOW };
        let phase: DispatchGuardPhase = await runDispatchGuardPhase({ stage: input.context, predicate: 'current.membership', frozenInputs: {},
          stateSnapshot: input.row, checkpoint: { revision: input.revision + (misuse === 'wrong-revision' ? 1 : 0), owner: 'team-1' },
          intent: candidate as unknown as typeof f.intent,
          evaluateGuard: () => true });
        if (misuse === 'forged') phase = { result: true, revalidate: async () => true };
        if (misuse === 'copied') phase = { ...phase };
        if (misuse === 'consumed') await phase.revalidate();
        return { phase, currentAuthority: () => true };
      }));
      await f.unchanged();
    }
  });

  it('refuses precreated, no-stage, copied-stage and foreign-stage phases at the same checkpoint', async () => {
    for (const misuse of ['precreated', 'no-stage', 'copied-stage', 'foreign-stage']) {
      const f = await fixture({}, false, allocateClaim);
      let retained: DispatchGuardPhase | undefined;
      const make = (stage?: SystemCommandContext) => runDispatchGuardPhase({ ...(stage === undefined ? {} : { stage }),
        predicate: 'current.membership', frozenInputs: {}, stateSnapshot: f.row,
        checkpoint: { revision: f.revision, owner: 'team-1' }, intent: f.intent, evaluateGuard: () => true });
      if (misuse === 'precreated') retained = await make();
      if (misuse === 'foreign-stage') {
        const foreign = await fixture({}, false, allocateClaim);
        assert.equal(foreign.revision, f.revision);
        await assert.rejects(foreign.run(async input => {
          retained = await make(input.context);
          throw new Error('foreign command closes without effects');
        }), /foreign command closes/);
        assert.equal(await foreign.store.readRevision(), foreign.revision);
      }
      await assert.rejects(f.run(async input => ({
        phase: retained ?? await make(misuse === 'copied-stage' ? { ...input.context } : undefined),
        currentAuthority: () => true,
      })));
      await f.unchanged();
    }
  });

  it('caught double or concurrent phase issuance poisons the original actual stage', async () => {
    for (const concurrent of [false, true]) {
      const f = await fixture({}, false, allocateClaim); let evaluations = 0;
      await assert.rejects(f.run(async input => {
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { release = resolve; });
        const make = () => runDispatchGuardPhase({ stage: input.context, predicate: 'current.membership',
          frozenInputs: {}, stateSnapshot: input.row,
          checkpoint: { revision: input.revision, owner: 'team-1' }, intent: f.intent,
          evaluateGuard: async () => { evaluations++; if (concurrent) await waiting; return true; } });
        const first = make();
        if (concurrent) {
          await assert.rejects(make(), /already issued/);
          release();
          return { phase: await first, currentAuthority: () => true };
        }
        const phase = await first;
        await assert.rejects(make(), /already issued/);
        return { phase, currentAuthority: () => true };
      }), /poisoned/);
      assert.equal(evaluations, 1);
      await f.unchanged();
    }
  });

  it('caught repeated transfers or late actual handle misuse poison commit evidence', async () => {
    for (const misuse of ['before-stage', 'during-authority', 'late-registration']) {
      const f = await fixture({}, false, allocateClaim);
      await assert.rejects(f.run(async input => {
        let execution!: DispatchGuardExecution;
        const phase = await runDispatchGuardPhase({ stage: input.context, predicate: 'current.membership', frozenInputs: {},
          stateSnapshot: input.row, checkpoint: { revision: input.revision, owner: 'team-1' }, intent: f.intent,
          evaluateGuard: (_predicate, _inputs, _snapshot, issued) => { execution = issued; return true; } });
        if (misuse === 'before-stage') {
          transferDispatchGuardPhase(phase);
          assert.throws(() => transferDispatchGuardPhase(phase), /already been transferred/);
        }
        return { phase, currentAuthority: () => {
          if (misuse === 'during-authority') assert.throws(() => transferDispatchGuardPhase(phase), /already been transferred/);
          if (misuse === 'late-registration') assert.throws(() => registerDispatchGuardRevalidation(execution, () => true), /not live/);
          return true;
        } };
      }));
      await f.unchanged();
    }
  });

  it('refuses moved physical revision and source failure without claim or skip effects', async () => {
    for (const moved of [false, true]) {
      const f = await fixture({}, false, allocateClaim);
      await assert.rejects(f.run(async input => {
        if (!moved) throw new Error('source guard failed');
        const phase = await runDispatchGuardPhase({ stage: input.context, predicate: 'current.membership', frozenInputs: {},
          stateSnapshot: input.row, checkpoint: { revision: input.revision, owner: 'team-1' }, intent: f.intent,
          evaluateGuard: () => false });
        await f.store.commit({ expectedRevision: input.revision, writes: [], history: [], receipt: null,
          outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [] });
        return { phase, currentAuthority: () => true };
      }));
      assert.equal(await f.store.readRevision(), f.revision + (moved ? 1 : 0));
      assert.deepEqual(await f.current(), f.row);
      assert.equal((await f.store.outboxGet(f.intent.item.id))?.status, 'pending');
    }
  });

  it('refuses forged stage contexts before source and closes an unawaited actual stage reader', async () => {
    let sourceCalls = 0;
    const command = createWorkDispatchClaimCommand(undefined, () => {
      sourceCalls++; throw new Error('source must not enter without a genuine stage');
    });
    await assert.rejects(runStage(command.stage,
      { intentId: 'op_1#0', claimId: 'claim', claimedAtMs: NOW, maxClaimAgeMs: MAX_AGE },
      fakeCtx(seed([{ model: WORK_DISPATCH_MODEL, row: dispatchRow('op_1#0') }]))));
    assert.equal(sourceCalls, 0);

    const f = await fixture({}, false, allocateClaim); const originalLoad = f.store.load;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    Object.defineProperty(f.store, 'load', { value: async (model: ModelName, id: RecordId) => {
      if (model === 'Membership') await waiting;
      return originalLoad(model, id);
    } });
    let reader!: Promise<StoredRow | null>;
    await assert.rejects(f.run(async input => {
      reader = input.context.load('Membership' as ModelName, 'u1' as RecordId);
      // Handle the eventual rejection without awaiting it in the source guard.
      void reader.catch(() => undefined);
      return { phase: await runDispatchGuardPhase({ stage: input.context, predicate: 'current.membership', frozenInputs: {},
        stateSnapshot: input.row, checkpoint: { revision: input.revision, owner: 'team-1' },
        intent: f.intent, evaluateGuard: () => false }), currentAuthority: () => true };
    }), /unawaited reader/);
    release(); await assert.rejects(reader, /crossed its original stage/);
    assert.equal(await f.store.readRevision(), f.revision); assert.deepEqual(await f.current(), f.row);
    assert.equal((await f.store.outboxGet(f.intent.item.id))?.status, 'pending');
  });
});

describe('kernel commands: dispatch.claim', () => {
  it('claims pending rows with a fenced conditional update', async () => {
    const row = dispatchRow('op_1#0');
    const ctx = fakeCtx(seed([{ model: WORK_DISPATCH_MODEL, row }]));
    const availabilityCalls: string[][] = [];
    const command = createWorkDispatchClaimCommand((intentId, target) => {
      availabilityCalls.push([intentId, target]);
      return true;
    });
    const staged = await command.stage(
      {
        intentId: 'op_1#0',
        claimId: 'claim_1',
        claimedAtMs: NOW,
        maxClaimAgeMs: MAX_AGE,
      },
      ctx,
    );
    assert.equal(staged.writes?.length, 1);
    const write = staged.writes?.[0];
    assert.equal(write?.kind, 'update');
    if (write?.kind === 'update') {
      assert.equal(write.model, WORK_DISPATCH_MODEL);
      assert.equal(write.id, 'op_1#0');
      assert.equal(write.expectedVersion, 1);
      assert.deepEqual(readDispatchRow(write.row), {
        ...readDispatchRow(row),
        state: 'claimed',
        claimId: 'claim_1',
        claimedAtMs: NOW,
      });
    }
    assert.deepEqual(staged.result, {
      claimed: true,
      intentId: 'op_1#0',
      claimId: 'claim_1',
    });
    assert.deepEqual(availabilityCalls, [['op_1#0', 'std.EmailV1.send']]);
  });

  it('refuses unavailable pending and stale claims without writes', async () => {
    const rows = [
      dispatchRow('op_1#0'),
      dispatchRow('op_1#1', {
        state: 'claimed', claimId: 'old', claimedAtMs: NOW - MAX_AGE,
      }),
    ];
    const ctx = fakeCtx(seed(rows.map((row) => ({ model: WORK_DISPATCH_MODEL, row }))));
    const availabilityCalls: string[][] = [];
    const command = createWorkDispatchClaimCommand((intentId, target) => {
      availabilityCalls.push([intentId, target]);
      return false;
    });
    for (const intentId of ['op_1#0', 'op_1#1']) {
      assert.deepEqual(await command.stage(
        { intentId, claimId: 'claim_1', claimedAtMs: NOW, maxClaimAgeMs: MAX_AGE }, ctx,
      ), {
        result: { claimed: false, reason: 'unavailable', intentId, target: 'std.EmailV1.send' },
      });
    }
    assert.deepEqual(availabilityCalls, [
      ['op_1#0', 'std.EmailV1.send'], ['op_1#1', 'std.EmailV1.send'],
    ]);
  });

  it('refuses superseded, guard-pinned, held and settled rows without writes', async () => {
    const held = dispatchRow('op_1#1', {
      state: 'claimed',
      claimId: 'winner',
      claimedAtMs: NOW,
    });
    const stale = dispatchRow('op_1#2', {
      state: 'claimed',
      claimId: 'old',
      claimedAtMs: NOW - MAX_AGE,
    });
    const pinned = dispatchRow('op_1#3', { guardVerdict: false });
    const settled = dispatchRow('op_1#4', { state: 'delivered' });
    const marked = dispatchRow('op_1#5');
    const ctx = fakeCtx(
      seed([
        { model: WORK_DISPATCH_MODEL, row: held },
        { model: WORK_DISPATCH_MODEL, row: stale },
        { model: WORK_DISPATCH_MODEL, row: pinned },
        { model: WORK_DISPATCH_MODEL, row: settled },
        { model: WORK_DISPATCH_MODEL, row: marked },
        {
          model: WORK_SUPERSESSION_MODEL,
          row: newSupersessionRow(
            { outboxId: 'op_1#5', byOccurrenceId: 'occ_1', markedAtMs: NOW },
            { nowMs: NOW, actor: ACTOR },
          ),
        },
      ]),
    );
    const availabilityCalls: string[][] = [];
    const command = createWorkDispatchClaimCommand((intentId, target) => {
      availabilityCalls.push([intentId, target]);
      return true;
    });
    const drive = (intentId: string) =>
      command.stage(
        { intentId, claimId: 'claim_9', claimedAtMs: NOW, maxClaimAgeMs: MAX_AGE },
        ctx,
      );
    // Superseded refuses before anything else.
    assert.deepEqual((await drive('op_1#5')).result, {
      claimed: false,
      reason: 'superseded',
      intentId: 'op_1#5',
    });
    assert.equal((await drive('op_1#5')).writes, undefined);
    // Guard-false pins undispatched.
    assert.deepEqual((await drive('op_1#3')).result, {
      claimed: false,
      reason: 'guard-false',
      intentId: 'op_1#3',
    });
    // Fresh claims lose and observe the winner.
    assert.deepEqual((await drive('op_1#1')).result, {
      claimed: false,
      reason: 'claimed',
      intentId: 'op_1#1',
      claimId: 'winner',
    });
    // Boundary-inclusive staleness reclaims (claimedAt + maxAge <= now).
    const reclaimed = await drive('op_1#2');
    assert.deepEqual(reclaimed.result, {
      claimed: true,
      reclaimed: true,
      intentId: 'op_1#2',
      claimId: 'claim_9',
    });
    assert.equal(reclaimed.writes?.length, 1);
    // Settled rows refuse with their state.
    assert.deepEqual((await drive('op_1#4')).result, {
      claimed: false,
      reason: 'settled',
      intentId: 'op_1#4',
      state: 'delivered',
    });
    // Only the eligible stale claim reaches actual installation availability.
    assert.deepEqual(availabilityCalls, [['op_1#2', 'std.EmailV1.send']]);
  });

  it('defers pending rows with a future availability', async () => {
    const row = dispatchRow('op_1#0', { availableAtMs: NOW + 5000 });
    const ctx = fakeCtx(seed([{ model: WORK_DISPATCH_MODEL, row }]));
    const command = createWorkDispatchClaimCommand(() => {
      throw new Error('deferred claims must not check availability');
    });
    const staged = await command.stage(
      {
        intentId: 'op_1#0',
        claimId: 'claim_1',
        claimedAtMs: NOW,
        maxClaimAgeMs: MAX_AGE,
      },
      ctx,
    );
    assert.deepEqual(staged.result, {
      claimed: false,
      reason: 'deferred',
      intentId: 'op_1#0',
      availableAtMs: NOW + 5000,
    });
    assert.equal(staged.writes, undefined);
  });

  it('reports settled before guard-false on terminal rows', async () => {
    const row = dispatchRow('op_1#0', { state: 'failed', guardVerdict: false });
    const ctx = fakeCtx(seed([{ model: WORK_DISPATCH_MODEL, row }]));
    const staged = await workDispatchClaimCommand.stage(
      {
        intentId: 'op_1#0',
        claimId: 'claim_1',
        claimedAtMs: NOW,
        maxClaimAgeMs: MAX_AGE,
      },
      ctx,
    );
    assert.deepEqual(staged.result, {
      claimed: false,
      reason: 'settled',
      intentId: 'op_1#0',
      state: 'failed',
    });
    assert.equal(staged.writes, undefined);
  });

  it('throws loudly on missing rows and bad args', async () => {
    const ctx = fakeCtx(seed([]));
    await assert.rejects(
      runStage(
        workDispatchClaimCommand.stage,
        {
          intentId: 'ghost',
          claimId: 'c',
          claimedAtMs: NOW,
          maxClaimAgeMs: MAX_AGE,
        },
        ctx,
      ),
      KernelTableError,
    );
    await assert.rejects(
      runStage(workDispatchClaimCommand.stage, { intentId: '' }, ctx),
      KernelTableError,
    );
  });
});

describe('kernel commands: dispatch.record-attempt', () => {
  it('records terminal attempts with attempts+1, cleared claim and ack', async () => {
    const row = dispatchRow('op_1#0', {
      state: 'claimed',
      claimId: 'claim_1',
      claimedAtMs: NOW,
      attempts: 2,
    });
    const ctx = fakeCtx(seed([{ model: WORK_DISPATCH_MODEL, row }]));
    const staged = await workDispatchRecordAttemptCommand.stage(
      {
        intentId: 'op_1#0',
        claimId: 'claim_1',
        outcome: {
          state: 'uncertain',
          errorCode: 'provider_transient',
          errorMessage: 'boom',
          availableAtMs: NOW + 1000,
        },
        ack: false,
      },
      ctx,
    );
    assert.equal(staged.writes?.length, 1);
    const write = staged.writes?.[0];
    assert.equal(write?.kind, 'update');
    if (write?.kind === 'update') {
      assert.equal(write.expectedVersion, 1);
      assert.deepEqual(readDispatchRow(write.row), {
        ...readDispatchRow(row),
        state: 'uncertain',
        attempts: 3,
        firstAttemptAtMs: NOW,
        claimId: null,
        claimedAtMs: null,
        deliveryId: null,
        errorCode: 'provider_transient',
        errorMessage: 'boom',
        availableAtMs: NOW + 1000,
      });
    }
    assert.deepEqual(staged.result, {
      recorded: true,
      intentId: 'op_1#0',
      state: 'uncertain',
      attempts: 3,
    });
    assert.equal(staged.outboxAck, undefined);
  });

  it('acks terminally settled intents and records skips without attempts', async () => {
    const done = dispatchRow('op_1#0', {
      state: 'claimed',
      claimId: 'claim_1',
      claimedAtMs: NOW,
    });
    const skip = dispatchRow('op_1#1', {
      state: 'claimed',
      claimId: 'claim_2',
      claimedAtMs: NOW,
      attempts: 1,
    });
    const ctx = fakeCtx(
      seed([
        { model: WORK_DISPATCH_MODEL, row: done },
        { model: WORK_DISPATCH_MODEL, row: skip },
      ]),
    );
    const delivered = await workDispatchRecordAttemptCommand.stage(
      {
        intentId: 'op_1#0',
        claimId: 'claim_1',
        outcome: { state: 'delivered', deliveryId: 'mail_1' },
        ack: true,
      },
      ctx,
    );
    assert.deepEqual(delivered.outboxAck, ['op_1#0']);
    assert.deepEqual(delivered.result, {
      recorded: true,
      intentId: 'op_1#0',
      state: 'delivered',
      attempts: 1,
    });
    const skipped = await workDispatchRecordAttemptCommand.stage(
      {
        intentId: 'op_1#1',
        claimId: 'claim_2',
        outcome: { state: 'pending', guardVerdict: false },
        ack: true,
      },
      ctx,
    );
    const write = skipped.writes?.[0];
    assert.equal(write?.kind, 'update');
    if (write?.kind === 'update') {
      const data = readDispatchRow(write.row);
      assert.equal(data.state, 'pending');
      assert.equal(data.guardVerdict, false);
      assert.equal(data.attempts, 1);
      assert.equal(data.claimId, null);
    }
    assert.deepEqual(skipped.outboxAck, ['op_1#1']);
  });

  it('requires a retry class on failed outcomes and stores it', async () => {
    const row = dispatchRow('op_1#0', {
      state: 'claimed',
      claimId: 'claim_1',
      claimedAtMs: NOW,
    });
    const ctx = fakeCtx(seed([{ model: WORK_DISPATCH_MODEL, row }]));
    await assert.rejects(
      runStage(
        workDispatchRecordAttemptCommand.stage,
        {
          intentId: 'op_1#0',
          claimId: 'claim_1',
          outcome: { state: 'failed', errorCode: 'boom' },
          ack: false,
        },
        ctx,
      ),
      /retryClass must be transient or terminal/,
    );
    const staged = await workDispatchRecordAttemptCommand.stage(
      {
        intentId: 'op_1#0',
        claimId: 'claim_1',
        outcome: { state: 'failed', retryClass: 'transient', errorCode: 'boom' },
        ack: false,
      },
      ctx,
    );
    const write = staged.writes?.[0];
    assert.equal(write?.kind, 'update');
    if (write?.kind === 'update') {
      assert.equal(readDispatchRow(write.row).retryClass, 'transient');
    }
  });

  it('rejects rival claims, unclaimed rows and malformed outcomes', async () => {
    const row = dispatchRow('op_1#0', {
      state: 'claimed',
      claimId: 'claim_1',
      claimedAtMs: NOW,
    });
    const pending = dispatchRow('op_1#1');
    const ctx = fakeCtx(
      seed([
        { model: WORK_DISPATCH_MODEL, row },
        { model: WORK_DISPATCH_MODEL, row: pending },
      ]),
    );
    // Rival claim id.
    await assert.rejects(
      runStage(
        workDispatchRecordAttemptCommand.stage,
        {
          intentId: 'op_1#0',
          claimId: 'rival',
          outcome: { state: 'delivered' },
          ack: true,
        },
        ctx,
      ),
      /does not hold/,
    );
    // Unclaimed row.
    await assert.rejects(
      runStage(
        workDispatchRecordAttemptCommand.stage,
        {
          intentId: 'op_1#1',
          claimId: 'claim_9',
          outcome: { state: 'delivered' },
          ack: true,
        },
        ctx,
      ),
      /does not hold/,
    );
    // Pending without a false verdict is not a skip.
    await assert.rejects(
      runStage(
        workDispatchRecordAttemptCommand.stage,
        {
          intentId: 'op_1#0',
          claimId: 'claim_1',
          outcome: { state: 'pending' },
          ack: false,
        },
        ctx,
      ),
      /require guardVerdict false/,
    );
    // Unknown outcome state.
    await assert.rejects(
      runStage(
        workDispatchRecordAttemptCommand.stage,
        {
          intentId: 'op_1#0',
          claimId: 'claim_1',
          outcome: { state: 'flying' },
          ack: false,
        },
        ctx,
      ),
      /must be pending, delivered/,
    );
  });
});

describe('kernel commands: dispatch.requeue', () => {
  it('returns ready uncertain/failed rows to pending with cleared outcome', async () => {
    const uncertain = dispatchRow('op_1#0', {
      state: 'uncertain',
      attempts: 1,
      firstAttemptAtMs: NOW - 500,
      errorCode: 'provider_transient',
      errorMessage: 'boom',
      availableAtMs: NOW - 1,
    });
    const failed = dispatchRow('op_1#1', {
      state: 'failed',
      attempts: 2,
      firstAttemptAtMs: NOW - 500,
      retryClass: 'transient',
      deliveryId: null,
      errorCode: 'provider_rejected',
      errorMessage: 'no',
      availableAtMs: null,
    });
    const ctx = fakeCtx(
      seed([
        { model: WORK_DISPATCH_MODEL, row: uncertain },
        { model: WORK_DISPATCH_MODEL, row: failed },
      ]),
    );
    for (const intentId of ['op_1#0', 'op_1#1']) {
      const staged = await workDispatchRequeueCommand.stage(
        { intentId, maxAttempts: 8, horizonMs: 3_600_000, notFound: true },
        ctx,
      );
      assert.deepEqual(staged.result, {
        requeued: true,
        dead: false,
        intentId,
        attempts: intentId === 'op_1#0' ? 1 : 2,
      });
      const write = staged.writes?.[0];
      assert.equal(write?.kind, 'update');
      if (write?.kind === 'update') {
        const data = readDispatchRow(write.row);
        assert.equal(data.state, 'pending');
        assert.equal(data.deliveryId, null);
        assert.equal(data.errorCode, null);
        assert.equal(data.errorMessage, null);
        assert.equal(data.availableAtMs, null);
        assert.equal(data.retryClass, null);
        // Horizon anchor survives across attempts.
        assert.equal(data.firstAttemptAtMs, NOW - 500);
      }
    }
  });

  it('refuses terminal failures and evidence-less uncertain rows', async () => {
    const terminal = dispatchRow('op_1#0', {
      state: 'failed',
      attempts: 1,
      firstAttemptAtMs: NOW - 500,
      retryClass: 'terminal',
      errorCode: 'require-false',
      availableAtMs: null,
    });
    const unclassified = dispatchRow('op_1#1', {
      state: 'failed',
      attempts: 1,
      firstAttemptAtMs: NOW - 500,
      errorCode: 'boom',
      availableAtMs: null,
    });
    const unknown = dispatchRow('op_1#2', {
      state: 'uncertain',
      attempts: 1,
      firstAttemptAtMs: NOW - 500,
      availableAtMs: null,
    });
    const ctx = fakeCtx(
      seed([
        { model: WORK_DISPATCH_MODEL, row: terminal },
        { model: WORK_DISPATCH_MODEL, row: unclassified },
        { model: WORK_DISPATCH_MODEL, row: unknown },
      ]),
    );
    for (const intentId of ['op_1#0', 'op_1#1']) {
      const refused = await workDispatchRequeueCommand.stage(
        { intentId, maxAttempts: 8, horizonMs: 3_600_000 },
        ctx,
      );
      assert.deepEqual(refused.result, {
        requeued: false,
        dead: false,
        intentId,
        reason: 'terminal',
        state: 'failed',
      });
      assert.equal(refused.writes, undefined);
    }
    const needsEvidence = await workDispatchRequeueCommand.stage(
      { intentId: 'op_1#2', maxAttempts: 8, horizonMs: 3_600_000 },
      ctx,
    );
    assert.deepEqual(needsEvidence.result, {
      requeued: false,
      dead: false,
      intentId: 'op_1#2',
      reason: 'needs-evidence',
    });
    assert.equal(needsEvidence.writes, undefined);
  });

  it('holds deferred rows and dead-letters exhausted ones', async () => {
    const deferred = dispatchRow('op_1#0', {
      state: 'uncertain',
      attempts: 1,
      firstAttemptAtMs: NOW - 500,
      availableAtMs: NOW + 60_000,
    });
    const capped = dispatchRow('op_1#1', {
      state: 'failed',
      attempts: 8,
      firstAttemptAtMs: NOW - 500,
      retryClass: 'transient',
    });
    const timedOut = dispatchRow('op_1#2', {
      state: 'uncertain',
      attempts: 2,
      firstAttemptAtMs: NOW - 3_600_000,
    });
    const ctx = fakeCtx(
      seed([
        { model: WORK_DISPATCH_MODEL, row: deferred },
        { model: WORK_DISPATCH_MODEL, row: capped },
        { model: WORK_DISPATCH_MODEL, row: timedOut },
      ]),
    );
    const held = await workDispatchRequeueCommand.stage(
      { intentId: 'op_1#0', maxAttempts: 8, horizonMs: 3_600_000, notFound: true },
      ctx,
    );
    assert.deepEqual(held.result, {
      requeued: false,
      dead: false,
      intentId: 'op_1#0',
      reason: 'deferred',
      availableAtMs: NOW + 60_000,
    });
    assert.equal(held.writes, undefined);
    for (const intentId of ['op_1#1', 'op_1#2']) {
      const dead = await workDispatchRequeueCommand.stage(
        { intentId, maxAttempts: 8, horizonMs: 3_600_000, notFound: true },
        ctx,
      );
      assert.deepEqual(dead.result, {
        requeued: false,
        dead: true,
        intentId,
        attempts: intentId === 'op_1#1' ? 8 : 2,
      });
      const write = dead.writes?.[0];
      assert.equal(write?.kind, 'update');
      if (write?.kind === 'update') {
        const data = readDispatchRow(write.row);
        assert.equal(data.state, 'dead');
        // Dead-lettering keeps the last classification as provenance.
        assert.equal(data.retryClass, intentId === 'op_1#1' ? 'transient' : null);
      }
    }
  });

  it('refuses non-retryable rows and validates the budget', async () => {
    const pending = dispatchRow('op_1#0');
    const ctx = fakeCtx(seed([{ model: WORK_DISPATCH_MODEL, row: pending }]));
    const refused = await workDispatchRequeueCommand.stage(
      { intentId: 'op_1#0', maxAttempts: 8, horizonMs: 3_600_000 },
      ctx,
    );
    assert.deepEqual(refused.result, {
      requeued: false,
      dead: false,
      intentId: 'op_1#0',
      reason: 'not-retryable',
      state: 'pending',
    });
    await assert.rejects(
      runStage(
        workDispatchRequeueCommand.stage,
        { intentId: 'op_1#0', maxAttempts: 0, horizonMs: 1000 },
        ctx,
      ),
      /maxAttempts must be an integer >= 1/,
    );
    await assert.rejects(
      runStage(
        workDispatchRequeueCommand.stage,
        { intentId: 'ghost', maxAttempts: 8, horizonMs: 1000 },
        ctx,
      ),
      KernelTableError,
    );
  });
});

describe('kernel commands: dispatch.release', () => {
  it('releases stale claims and keeps fresh or absent ones', async () => {
    const stale = dispatchRow('op_1#0', {
      state: 'claimed',
      claimId: 'old',
      claimedAtMs: NOW - MAX_AGE - 1,
    });
    const fresh = dispatchRow('op_1#1', {
      state: 'claimed',
      claimId: 'live',
      claimedAtMs: NOW,
    });
    const bare = dispatchRow('op_1#2', { state: 'claimed' });
    const ctx = fakeCtx(
      seed([
        { model: WORK_DISPATCH_MODEL, row: stale },
        { model: WORK_DISPATCH_MODEL, row: fresh },
        { model: WORK_DISPATCH_MODEL, row: bare },
      ]),
    );
    const released = await workDispatchReleaseCommand.stage(
      { intentId: 'op_1#0', maxClaimAgeMs: MAX_AGE },
      ctx,
    );
    assert.deepEqual(released.result, { released: true, intentId: 'op_1#0' });
    assert.equal(released.writes?.length, 1);
    const kept = await workDispatchReleaseCommand.stage(
      { intentId: 'op_1#1', maxClaimAgeMs: MAX_AGE },
      ctx,
    );
    assert.deepEqual(kept.result, {
      released: false,
      intentId: 'op_1#1',
      reason: 'claim-fresh',
    });
    assert.equal(kept.writes, undefined);
    // No recorded claim: a live dispatcher may hold it.
    const unclaimed = await workDispatchReleaseCommand.stage(
      { intentId: 'op_1#2', maxClaimAgeMs: MAX_AGE },
      ctx,
    );
    assert.deepEqual(unclaimed.result, {
      released: false,
      intentId: 'op_1#2',
      reason: 'claim-fresh',
    });
  });
});

describe('kernel commands: dispatch.supersede', () => {
  it('marks pending origin intents, skipping others and existing marks', async () => {
    const pendingA = dispatchRow('op_1#a', { originOccurrence: 'occ_9' });
    const pendingB = dispatchRow('op_1#b', { originOccurrence: 'occ_9' });
    const claimed = dispatchRow('op_1#c', {
      originOccurrence: 'occ_9',
      state: 'claimed',
      claimId: 'live',
      claimedAtMs: NOW,
    });
    const foreign = dispatchRow('op_2#a', { originOccurrence: 'occ_other' });
    const ctx = fakeCtx(
      seed([
        { model: WORK_DISPATCH_MODEL, row: pendingA },
        { model: WORK_DISPATCH_MODEL, row: pendingB },
        { model: WORK_DISPATCH_MODEL, row: claimed },
        { model: WORK_DISPATCH_MODEL, row: foreign },
        {
          model: WORK_SUPERSESSION_MODEL,
          row: newSupersessionRow(
            { outboxId: 'op_1#b', byOccurrenceId: 'occ_8', markedAtMs: NOW - 1 },
            { nowMs: NOW, actor: ACTOR },
          ),
        },
      ]),
    );
    const staged = await workDispatchSupersedeCommand.stage(
      { originOccurrence: 'occ_9', byOccurrenceId: 'occ_10' },
      ctx,
    );
    // Only op_1#a: op_1#b already marked, op_1#c claimed, op_2#a foreign.
    assert.deepEqual(staged.result, { superseded: ['op_1#a'] });
    assert.equal(staged.writes?.length, 1);
    const write = staged.writes?.[0];
    assert.equal(write?.kind, 'insert');
    if (write?.kind === 'insert') {
      assert.equal(write.model, WORK_SUPERSESSION_MODEL);
      assert.deepEqual(write.row.data, {
        outboxId: 'op_1#a',
        byOccurrenceId: 'occ_10',
        markedAtMs: NOW,
      });
    }
  });
});

describe('kernel commands: occurrence.put-receipt', () => {
  it('shares the portable command with the registry', () => {
    assert.equal(workOccurrencePutReceiptCommand, portableOccurrencePutReceiptCommand);
    assert.ok(WORK_SYSTEM_COMMANDS.includes(portableOccurrencePutReceiptCommand));
  });

  it('inserts receipts once and replays duplicates', async () => {
    const ctx = fakeCtx(seed([]));
    const first = await workOccurrencePutReceiptCommand.stage(
      {
        occurrenceId: 'occ_1',
        status: 'completed',
        result: { ok: true },
        code: null,
        message: null,
      },
      ctx,
    );
    assert.deepEqual(first.result, { duplicate: false, occurrenceId: 'occ_1' });
    assert.equal(first.writes?.length, 1);
    const write = first.writes?.[0];
    assert.equal(write?.kind, 'insert');
    if (write?.kind !== 'insert') throw new Error('unreachable');
    // Second run sees the winner's receipt.
    const replay = fakeCtx(
      seed([{ model: WORK_OCCURRENCE_MODEL, row: write.row }]),
    );
    const second = await workOccurrencePutReceiptCommand.stage(
      {
        occurrenceId: 'occ_1',
        status: 'failed',
        result: null,
        code: 'x',
        message: 'late',
      },
      replay,
    );
    assert.equal(second.writes, undefined);
    assert.deepEqual(second.result, {
      duplicate: true,
      receipt: {
        occurrenceId: 'occ_1',
        status: 'completed',
        result: { ok: true },
        code: null,
        message: null,
        recordedAtMs: NOW,
      },
    });
  });

  it('rejects bad statuses', async () => {
    const ctx = fakeCtx(seed([]));
    await assert.rejects(
      runStage(
        workOccurrencePutReceiptCommand.stage,
        { occurrenceId: 'occ_1', status: 'maybe' },
        ctx,
      ),
      /must be completed or failed/,
    );
  });
});

const SCOPE = { app: 'CanExpense', owner: 'team_1', ownerPackage: 'expense' };

function scheduleRow(
  occurrenceId: string,
  over: Record<string, unknown> = {},
): StoredRow {
  return newScheduleRow(
    {
      occurrenceId,
      key: 'reminder',
      scopeApp: SCOPE.app,
      scopeOwner: SCOPE.owner,
      scopeOwnerPackage: SCOPE.ownerPackage,
      at: NOW + 1000,
      event: 'expense.remind',
      payload: {},
      replaces: null,
      state: 'pending',
      ...over,
    },
    { nowMs: NOW, actor: ACTOR },
  );
}

describe('kernel commands: schedule.due', () => {
  const input = {
    key: 'reminder',
    scope: SCOPE,
    at: NOW - 1,
    event: 'expense.remind',
    occurrenceId: 'occ_1',
  };

  it('captures the stored due head and stages its fenced admission and consumption', async () => {
    const payload = { reminder: { recipients: ['original'] } };
    const row = { ...scheduleRow('occ_1', { at: input.at, payload }), version: 7 as RecordVersion };
    const store = seed([{ model: WORK_SCHEDULE_MODEL, row }]);
    const ctx = fakeCtx(store);
    let commits = 0;
    const readers = {
      ...ctx,
      commit: () => { commits += 1; },
      query: async (spec: QuerySpec) => {
        await Promise.resolve();
        payload.reminder.recipients[0] = 'changed';
        return ctx.query(spec);
      },
    };
    const result = await stageDueSchedule(input, readers);
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') throw new Error('unreachable');
    assert.deepEqual(result.occurrence.payload, { reminder: { recipients: ['original'] } });
    assert.ok(Object.isFrozen(result.occurrence));
    assert.ok(Object.isFrozen(result.occurrence.payload));
    assert.ok(Object.isFrozen(result.occurrence.payload['reminder']));
    const write = result.effects.writes?.[0];
    assert.equal(result.effects.writes?.length, 1);
    assert.equal(write?.kind, 'update');
    if (write?.kind !== 'update') throw new Error('unreachable');
    assert.equal(write.model, WORK_SCHEDULE_MODEL);
    assert.equal(write.id, 'occ_1');
    assert.equal(write.expectedVersion, 7);
    assert.equal(write.row.data['state'], 'admitted');
    assert.deepEqual(write.row.data['payload'], { reminder: { recipients: ['original'] } });
    assert.deepEqual(result.effects.schedules, [
      { op: 'cancel', key: 'CanExpense/expense/team_1/reminder' },
    ]);
    assert.equal(commits, 0);
    assert.equal(store.get(`${WORK_SCHEDULE_MODEL}\0occ_1`)?.data['state'], 'pending');
    assert.equal(row.version, 7);
  });

  it('refuses future, obsolete, mismatched and already-admitted deliveries without effects', async () => {
    const cases = [
      {
        request: { ...input, at: NOW + 1 },
        rows: [scheduleRow('occ_1', { at: NOW + 1 })],
        reason: 'future',
      },
      {
        request: input,
        rows: [
          scheduleRow('occ_1', { at: input.at }),
          scheduleRow('occ_2', { at: input.at, replaces: 'occ_1' }),
        ],
        reason: 'stale',
      },
      {
        request: { ...input, scope: { ...SCOPE, ownerPackage: 'other-package' } },
        rows: [scheduleRow('occ_1', { at: input.at })],
        reason: 'mismatched',
      },
      {
        request: { ...input, event: 'expense.other' },
        rows: [scheduleRow('occ_1', { at: input.at })],
        reason: 'mismatched',
      },
      {
        request: input,
        rows: [{ ...scheduleRow('occ_1', { at: input.at }), id: 'different-row' as RecordId }],
        reason: 'mismatched',
      },
      {
        request: input,
        rows: [scheduleRow('occ_1', { at: input.at, state: 'admitted' })],
        reason: 'admitted',
      },
    ];
    for (const entry of cases) {
      const store = seed(entry.rows.map((row) => ({ model: WORK_SCHEDULE_MODEL, row })));
      const ctx = fakeCtx(store);
      // The corrupted-identity case supplies the requested slot with a wrong row id.
      const readers = entry.rows[0]?.id === 'different-row'
        ? { ...ctx, load: async () => entry.rows[0]! }
        : ctx;
      assert.deepEqual(await stageDueSchedule(entry.request, readers), {
        status: 'refused', reason: entry.reason,
      });
    }
  });

  it('replays the original receipt without consuming its replacement', async () => {
    const original = scheduleRow('occ_1', { at: input.at, state: 'superseded' });
    const replacement = scheduleRow('occ_2', { at: NOW, replaces: 'occ_1' });
    const receiptData = {
      occurrenceId: 'occ_1', status: 'completed' as const,
      result: { done: true }, code: null, message: null, recordedAtMs: NOW,
    };
    const store = seed([
      { model: WORK_SCHEDULE_MODEL, row: original },
      { model: WORK_SCHEDULE_MODEL, row: replacement },
      {
        model: WORK_OCCURRENCE_MODEL,
        row: newOccurrenceRow(receiptData, { nowMs: NOW, actor: ACTOR }),
      },
    ]);
    const ctx = fakeCtx(store);
    let queried = false;
    const result = await stageDueSchedule(input, {
      ...ctx,
      query: async (spec) => { queried = true; return ctx.query(spec); },
    });
    assert.deepEqual(result, { status: 'replayed', receipt: receiptData });
    assert.equal(queried, false);
    assert.equal(store.get(`${WORK_SCHEDULE_MODEL}\0occ_2`), replacement);
    assert.equal(replacement.data['state'], 'pending');
  });
});

describe('kernel commands: schedule.put', () => {
  it('inserts with the L3 replace op when the key is fresh', async () => {
    const ctx = fakeCtx(seed([]));
    const staged = await workSchedulePutCommand.stage(
      {
        key: 'reminder',
        scope: SCOPE,
        at: NOW + 1000,
        event: 'expense.remind',
        payload: { n: 1 },
        occurrenceId: 'occ_1',
      },
      ctx,
    );
    assert.deepEqual(staged.result, {
      admitted: 'occ_1',
      supersededId: null,
      supersededIds: [],
      affectedOutboxIds: [],
    });
    assert.equal(staged.writes?.length, 1);
    assert.deepEqual(staged.schedules, [
      {
        op: 'replace',
        key: 'CanExpense/expense/team_1/reminder',
        at: NOW + 1000,
        event: 'expense.remind',
        payload: { n: 1 },
      },
    ]);
  });

  it('captures nested payload before asynchronous schedule queries', async () => {
    const payload = { reminder: { recipients: ['original'], count: 1 } };
    const ctx = fakeCtx(seed([]));
    const staged = await portableSchedulePutCommand.stage(
      {
        key: 'reminder',
        scope: SCOPE,
        at: NOW + 1000,
        event: 'expense.remind',
        payload,
        occurrenceId: 'occ_1',
      },
      {
        ...ctx,
        query: async (spec) => {
          await Promise.resolve();
          payload.reminder.recipients[0] = 'changed';
          payload.reminder.count = 2;
          return ctx.query(spec);
        },
      },
    );
    assert.deepEqual(payload, { reminder: { recipients: ['changed'], count: 2 } });
    const write = staged.writes?.[0];
    assert.equal(write?.kind, 'insert');
    if (write?.kind !== 'insert') throw new Error('unreachable');
    assert.equal(write.model, WORK_SCHEDULE_MODEL);
    const captured = { reminder: { recipients: ['original'], count: 1 } };
    assert.deepEqual(write.row.data['payload'], captured);
    const schedule = staged.schedules?.[0];
    assert.equal(schedule?.op, 'replace');
    if (schedule?.op !== 'replace') throw new Error('unreachable');
    assert.deepEqual(schedule.payload, captured);
  });

  it('replaces pending predecessors with lineage and intent marks', async () => {
    const previous = scheduleRow('occ_1');
    const intent = dispatchRow('op_1#0', { originOccurrence: 'occ_1' });
    const decoy = scheduleRow('occ_9', { key: 'other-key' });
    const ctx = fakeCtx(
      seed([
        { model: WORK_SCHEDULE_MODEL, row: previous },
        { model: WORK_SCHEDULE_MODEL, row: decoy },
        { model: WORK_DISPATCH_MODEL, row: intent },
      ]),
    );
    const staged = await workSchedulePutCommand.stage(
      {
        key: 'reminder',
        scope: SCOPE,
        at: NOW + 2000,
        event: 'expense.remind',
        payload: {},
        occurrenceId: 'occ_2',
      },
      ctx,
    );
    assert.deepEqual(staged.result, {
      admitted: 'occ_2',
      supersededId: 'occ_1',
      supersededIds: ['occ_1'],
      affectedOutboxIds: ['op_1#0'],
    });
    // Supersede update + lineage insert + supersession mark.
    assert.equal(staged.writes?.length, 3);
    const kinds = staged.writes?.map((write) => write.kind);
    assert.deepEqual(kinds, ['update', 'insert', 'insert']);
  });

  it('follows replaces linkage past lexicographic order', async () => {
    const old = scheduleRow('occ_9', { state: 'superseded' });
    const head = scheduleRow('occ_10', { replaces: 'occ_9' });
    const ctx = fakeCtx(
      seed([
        { model: WORK_SCHEDULE_MODEL, row: old },
        { model: WORK_SCHEDULE_MODEL, row: head },
      ]),
    );
    const staged = await workSchedulePutCommand.stage(
      {
        key: 'reminder',
        scope: SCOPE,
        at: NOW + 2000,
        event: 'expense.remind',
        payload: {},
        occurrenceId: 'occ_11',
      },
      ctx,
    );
    assert.deepEqual(staged.result, {
      admitted: 'occ_11',
      supersededId: 'occ_10',
      supersededIds: ['occ_10'],
      affectedOutboxIds: [],
    });
  });

  it('converges racing twin heads on the next put', async () => {
    const old = scheduleRow('occ_9', { state: 'superseded' });
    const twinA = scheduleRow('occ_10', { replaces: 'occ_9' });
    const twinB = scheduleRow('occ_11', { replaces: 'occ_9' });
    const ctx = fakeCtx(
      seed([
        { model: WORK_SCHEDULE_MODEL, row: old },
        { model: WORK_SCHEDULE_MODEL, row: twinA },
        { model: WORK_SCHEDULE_MODEL, row: twinB },
      ]),
    );
    const staged = await workSchedulePutCommand.stage(
      {
        key: 'reminder',
        scope: SCOPE,
        at: NOW + 2000,
        event: 'expense.remind',
        payload: {},
        occurrenceId: 'occ_12',
      },
      ctx,
    );
    assert.deepEqual(staged.result, {
      admitted: 'occ_12',
      supersededId: 'occ_11',
      supersededIds: ['occ_11', 'occ_10'],
      affectedOutboxIds: [],
    });
    // Two supersede updates + the lineage insert.
    assert.equal(staged.writes?.length, 3);
  });

  it('leaves non-pending predecessors to complete and rejects bad payloads', async () => {
    const admitted = scheduleRow('occ_1', { state: 'admitted' });
    const ctx = fakeCtx(seed([{ model: WORK_SCHEDULE_MODEL, row: admitted }]));
    const staged = await workSchedulePutCommand.stage(
      {
        key: 'reminder',
        scope: SCOPE,
        at: NOW + 2000,
        event: 'expense.remind',
        payload: {},
        occurrenceId: 'occ_2',
      },
      ctx,
    );
    assert.deepEqual(staged.result, {
      admitted: 'occ_2',
      supersededId: null,
      supersededIds: [],
      affectedOutboxIds: [],
    });
    assert.equal(staged.writes?.length, 1);
    await assert.rejects(
      runStage(
        workSchedulePutCommand.stage,
        {
          key: 'reminder',
          scope: SCOPE,
          at: NOW,
          event: 'e',
          payload: [1],
          occurrenceId: 'occ_9',
        },
        ctx,
      ),
      /payload must be an object/,
    );
  });
});

describe('kernel commands: schedule.cancel', () => {
  it('cancels pending entries with marks and the L3 cancel op', async () => {
    const previous = scheduleRow('occ_1');
    const intent = dispatchRow('op_1#0', { originOccurrence: 'occ_1' });
    const ctx = fakeCtx(
      seed([
        { model: WORK_SCHEDULE_MODEL, row: previous },
        { model: WORK_DISPATCH_MODEL, row: intent },
      ]),
    );
    const staged = await workScheduleCancelCommand.stage(
      { key: 'reminder', scope: SCOPE },
      ctx,
    );
    assert.deepEqual(staged.result, {
      cancelled: 'occ_1',
      cancelledIds: ['occ_1'],
      affectedOutboxIds: ['op_1#0'],
    });
    assert.equal(staged.writes?.length, 2);
    assert.deepEqual(staged.schedules, [
      { op: 'cancel', key: 'CanExpense/expense/team_1/reminder' },
    ]);
  });

  it('cancels the linked head past lexicographic order', async () => {
    const old = scheduleRow('occ_9', { state: 'superseded' });
    const head = scheduleRow('occ_10', { replaces: 'occ_9' });
    const ctx = fakeCtx(
      seed([
        { model: WORK_SCHEDULE_MODEL, row: old },
        { model: WORK_SCHEDULE_MODEL, row: head },
      ]),
    );
    const staged = await workScheduleCancelCommand.stage(
      { key: 'reminder', scope: SCOPE },
      ctx,
    );
    assert.deepEqual(staged.result, {
      cancelled: 'occ_10',
      cancelledIds: ['occ_10'],
      affectedOutboxIds: [],
    });
  });

  it('cancels every live head on a raced key', async () => {
    const old = scheduleRow('occ_9', { state: 'superseded' });
    const twinA = scheduleRow('occ_10', { replaces: 'occ_9' });
    const twinB = scheduleRow('occ_11', { replaces: 'occ_9' });
    const ctx = fakeCtx(
      seed([
        { model: WORK_SCHEDULE_MODEL, row: old },
        { model: WORK_SCHEDULE_MODEL, row: twinA },
        { model: WORK_SCHEDULE_MODEL, row: twinB },
      ]),
    );
    const staged = await workScheduleCancelCommand.stage(
      { key: 'reminder', scope: SCOPE },
      ctx,
    );
    assert.deepEqual(staged.result, {
      cancelled: 'occ_11',
      cancelledIds: ['occ_11', 'occ_10'],
      affectedOutboxIds: [],
    });
    assert.equal(staged.writes?.length, 2);
  });

  it('no-ops on missing and terminal keys', async () => {
    const missing = fakeCtx(seed([]));
    assert.deepEqual(
      (
        await workScheduleCancelCommand.stage(
          { key: 'ghost', scope: SCOPE },
          missing,
        )
      ).result,
      { cancelled: null, cancelledIds: [], affectedOutboxIds: [] },
    );
    const terminal = fakeCtx(
      seed([
        {
          model: WORK_SCHEDULE_MODEL,
          row: scheduleRow('occ_1', { state: 'cancelled' }),
        },
      ]),
    );
    const staged = await workScheduleCancelCommand.stage(
      { key: 'reminder', scope: SCOPE },
      terminal,
    );
    assert.deepEqual(staged.result, {
      cancelled: 'occ_1',
      cancelledIds: [],
      affectedOutboxIds: [],
    });
    assert.equal(staged.writes, undefined);
    assert.equal(staged.schedules, undefined);
  });
});

describe('kernel commands: schedule key embedding', () => {
  it('embeds scope percent-encoded with ownerPackage second', async () => {
    const ctx = fakeCtx(seed([]));
    const staged = await workSchedulePutCommand.stage(
      {
        key: 'a/b c',
        scope: { app: 'Can X', owner: 't/1', ownerPackage: 'my pkg' },
        at: NOW,
        event: 'e',
        payload: {},
        occurrenceId: 'occ_1',
      },
      ctx,
    );
    assert.deepEqual(staged.schedules, [
      {
        op: 'replace',
        key: 'Can%20X/my%20pkg/t%2F1/a%2Fb%20c',
        at: NOW,
        event: 'e',
        payload: {},
      },
    ]);
  });

  it('holds 128 exactly and fails closed at 129 in put and cancel', async () => {
    // Prefix 'CanExpense/expense/team_1/' is 26 chars; 102 more hits 128.
    const okKey = 'k'.repeat(102);
    assert.equal(`CanExpense/expense/team_1/${okKey}`.length, 128);
    const ok = await workSchedulePutCommand.stage(
      {
        key: okKey,
        scope: SCOPE,
        at: NOW,
        event: 'e',
        payload: {},
        occurrenceId: 'occ_1',
      },
      fakeCtx(seed([])),
    );
    assert.equal(ok.writes?.length, 1);
    await assert.rejects(
      runStage(
        workSchedulePutCommand.stage,
        {
          key: 'k'.repeat(103),
          scope: SCOPE,
          at: NOW,
          event: 'e',
          payload: {},
          occurrenceId: 'occ_2',
        },
        fakeCtx(seed([])),
      ),
      /exceeds 128 characters/,
    );
    await assert.rejects(
      runStage(
        workScheduleCancelCommand.stage,
        { key: 'k'.repeat(103), scope: SCOPE },
        fakeCtx(seed([])),
      ),
      /exceeds 128 characters/,
    );
  });
});

describe('kernel commands: every.advance-slot', () => {
  it('initializes, advances and holds slots', async () => {
    const empty = fakeCtx(seed([]));
    const first = await workEveryAdvanceSlotCommand.stage(
      {
        app: 'CanTasks',
        handler: 'TeamTasks.tick',
        scope: 'team',
        owner: 'team_1',
        slot: 42,
      },
      empty,
    );
    assert.deepEqual(first.result, {
      advanced: true,
      previous: null,
      slot: 42,
    });
    assert.equal(first.writes?.length, 1);
    const tracker = newEverySlotRow(
      {
        scopeKey: 'team:team_1',
        app: 'CanTasks',
        handler: 'TeamTasks.tick',
        scope: 'team',
        owner: 'team_1',
        slot: 42,
      },
      { nowMs: NOW, actor: ACTOR },
    );
    const ctx = fakeCtx(seed([{ model: WORK_EVERY_SLOT_MODEL, row: tracker }]));
    const held = await workEveryAdvanceSlotCommand.stage(
      {
        app: 'CanTasks',
        handler: 'TeamTasks.tick',
        scope: 'team',
        owner: 'team_1',
        slot: 42,
      },
      ctx,
    );
    assert.deepEqual(held.result, {
      advanced: false,
      previous: 42,
      slot: 42,
    });
    assert.equal(held.writes, undefined);
    const advanced = await workEveryAdvanceSlotCommand.stage(
      {
        app: 'CanTasks',
        handler: 'TeamTasks.tick',
        scope: 'team',
        owner: 'team_1',
        slot: 43,
      },
      ctx,
    );
    assert.deepEqual(advanced.result, {
      advanced: true,
      previous: 42,
      slot: 43,
    });
    assert.equal(advanced.writes?.length, 1);
  });

  it('tracks slots independently per app and handler', async () => {
    const empty = fakeCtx(seed([]));
    const first = await workEveryAdvanceSlotCommand.stage(
      {
        app: 'CanTasks',
        handler: 'A.tick',
        scope: 'team',
        owner: 'team_1',
        slot: 42,
      },
      empty,
    );
    const write = first.writes?.[0];
    assert.equal(write?.kind, 'insert');
    if (write?.kind !== 'insert') {
      assert.fail('expected the initializing advance to stage an insert');
    }
    const ctx = fakeCtx(seed([{ model: WORK_EVERY_SLOT_MODEL, row: write.row }]));
    const second = await workEveryAdvanceSlotCommand.stage(
      {
        app: 'CanTasks',
        handler: 'B.tick',
        scope: 'team',
        owner: 'team_1',
        slot: 42,
      },
      ctx,
    );
    assert.deepEqual(second.result, {
      advanced: true,
      previous: null,
      slot: 42,
    });
  });

  it('rejects root scopes exactly like admission', async () => {
    const ctx = fakeCtx(seed([]));
    await assert.rejects(
      runStage(
        workEveryAdvanceSlotCommand.stage,
        {
          app: 'CanTasks',
          handler: 'TeamTasks.tick',
          scope: 'root',
          owner: 'app',
          slot: 1,
        },
        ctx,
      ),
      RootRecurrenceNotSupportedError,
    );
  });
});


it('pins private mail recipient once under the exact held user-send claim without result disclosure', async () => {
  const row = dispatchRow('private-mail', { source: 'std.EmailV1.send_user', state: 'claimed', claimId: 'held', claimedAtMs: NOW });
  const ctx = (entry = row) => fakeCtx(seed([{ model: WORK_DISPATCH_MODEL, row: entry }]));
  const args = { intentId: row.id, claimId: 'held', mailRecipientUser: 'selected', mailRecipientTeam: 'team',
    mailRecipientEmail: 'selected@example.test' };
  const staged = await runStage(workDispatchPinMailRecipientCommand.stage, args, ctx());
  const write = staged.writes?.[0]; assert.ok(write?.kind === 'update');
  assert.equal(write.expectedVersion, row.version);
  assert.equal(readDispatchRow(write.row).mailRecipientEmail, args.mailRecipientEmail);
  assert.deepEqual(staged.result, { pinned: true, existing: false, intentId: row.id });
  const replay = await runStage(workDispatchPinMailRecipientCommand.stage, args, ctx(structuredClone(write.row)));
  assert.equal(replay.writes, undefined);
  assert.deepEqual(replay.result, { pinned: true, existing: true, intentId: row.id });
  for (const mailRecipientEmail of ['changed@example.test']) await assert.rejects(runStage(workDispatchPinMailRecipientCommand.stage,
    { ...args, mailRecipientEmail }, ctx(write.row)), /cannot be replaced/);
  for (const over of [{ source: 'std.EmailV1.send' }, { claimId: 'other' }, { state: 'pending' }]) {
    await assert.rejects(runStage(workDispatchPinMailRecipientCommand.stage, args, ctx({ ...row, data: { ...row.data, ...over } })), /original held user send/);
  }
});
