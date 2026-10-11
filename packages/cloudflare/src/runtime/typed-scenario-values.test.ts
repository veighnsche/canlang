import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { ArtifactOperationInput, CompileArtifact, MutationEnvelope, MutationResult, ResolvedIdentity, StoragePort } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import {
  FIXED_NOW, asId, asModel, asOperation, asOperationId, createMemoryIdentityStore,
  makeIdentity, seedMember, uuidv7,
} from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker, type MutationOutcome } from '@canlang/cloudflare/worker/assembly';

const APP = 'TypedScenarioValues';
const MODEL = asModel(`${APP}.Counter`);
const fixturePath = resolve('packages/cloudflare/test/fixtures/typed-scenario-values.json');
let sequence = 0;
function envelope(operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope {
  return { operation: `${APP}.${operation}`, inputs,
    operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)) };
}
function committed(outcome: MutationOutcome, status = 'committed') {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, status);
  return outcome.result;
}
function rejected(outcome: MutationOutcome, code?: string) {
  assert.ok('error' in outcome, JSON.stringify(outcome));
  if (code !== undefined) assert.equal(outcome.error.code, code);
  return outcome.error;
}
async function refusesUnassociatedReplay(
  invoker: ReturnType<typeof buildInvoker>, store: StoragePort,
  request: MutationEnvelope, identity: ResolvedIdentity,
): Promise<void> {
  const receiptKey = { app: APP, owner: identity.team!.team_id, principal: identity.actor!.user_id,
    operation: asOperation(request.operation), operationId: asOperationId(request.operation_id) };
  const snapshot = async () => {
    const rows = await store.query({ model: MODEL, authority: 'owner', archived: 'include' });
    return { revision: await store.readRevision(), rows,
      history: await Promise.all(rows.map(row => store.historyFor(MODEL, row.id))),
      outbox: await store.outboxPending(), schedules: await store.schedulesDue(Number.MAX_SAFE_INTEGER, 1_000),
      receipt: await store.readReceipt(receiptKey) };
  };
  const before = await snapshot();
  assert.equal(before.receipt?.outcome.status, 'committed');
  assert.equal(Object.hasOwn(before.receipt!.outcome, 'scenario'), false);
  const error = rejected(await invoker.invokeMutation(request, identity), 'validation');
  assert.equal(error.message, 'Saved scenario has no supported execution association.');
  assert.equal(error.operation_id, request.operation_id); assert.equal(error.retryable, false);
  assert.deepEqual(await snapshot(), before);
}
async function replaysWithoutEffects(
  invoker: ReturnType<typeof buildInvoker>, store: StoragePort,
  request: MutationEnvelope, identity: ResolvedIdentity, expectedResult: unknown,
): Promise<MutationResult> {
  const receiptKey = { app: APP, owner: identity.team!.team_id, principal: identity.actor!.user_id,
    operation: asOperation(request.operation), operationId: asOperationId(request.operation_id) };
  const snapshot = async () => {
    const rows = await store.query({ model: MODEL, authority: 'owner', archived: 'include' });
    return { revision: await store.readRevision(), rows,
      history: await Promise.all(rows.map(row => store.historyFor(MODEL, row.id))),
      outbox: await store.outboxPending(), schedules: await store.schedulesDue(Number.MAX_SAFE_INTEGER, 1_000),
      receipt: await store.readReceipt(receiptKey) };
  };
  const before = await snapshot();
  assert.equal(before.receipt?.outcome.status, 'committed');
  assert.ok(Object.hasOwn(before.receipt!.outcome, 'scenario'), 'supported replay retains genuine original capture');
  const replay = committed(await invoker.invokeMutation(request, identity), 'replayed');
  assert.equal(replay.operation_id, request.operation_id);
  assert.deepEqual(replay.result, expectedResult);
  assert.deepEqual(await snapshot(), before);
  return replay;
}
async function artifact(): Promise<CompileArtifact> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
}
async function assemble(input: CompileArtifact, workDir: string) {
  return assembleModules({ artifact: input, sourcePath: fixturePath }, {
    workDir, stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
    uiUrl: import.meta.resolve('@canlang/ui'),
  });
}
async function openD1(persistDir: string) {
  const worker = new Miniflare({
    compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: 'typed-scenario-values' }, d1Persist: persistDir,
  });
  const database = await worker.getD1Database('DB') as unknown as D1Database;
  await ensureSchema(database);
  return { worker, store: createD1Storage(database) };
}
async function memberWorld() {
  // Identity and membership are memory fixtures; persistence claims cover D1 State.
  const memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ membership: member.membership, email: member.user.email });
  const outsider = makeIdentity({ userId: 'nonmember', team: member.team, membership: null });
  return { memberships, identity, outsider };
}

test('actual compiled scenarios preserve typed staging, receipts and persisted D1 replay', async () => {
  const compiled = await artifact();
  for (const [name, type] of [
    ['increment', 'int'], ['twice', 'int'], ['rollback', 'int'], ['echo', 'int'],
    ['observedVersion', 'int'], ['finish', 'void'], ['boundNullable', 'int?'], ['boundArray', 'int[]'],
  ] as const) {
    const result = compiled.operations?.find(op => op.name === `${APP}.${name}`)?.result;
    assert.ok(result?.disclosure, `${name} requires genuine emitted disclosure`);
    assert.deepEqual(result, { type, disclosure: result.disclosure });
    assert.equal(result.disclosure.version, 1);
    assert.ok(result.disclosure.returns.length > 0);
    assert.equal(result.disclosure.source.path, 'packages/cloudflare/test/fixtures/typed-scenario-values.can');
  }
  assert.equal(compiled.operations?.find(op => op.name === `${APP}.born`)?.result?.type, 'int');
  assert.equal(compiled.operations?.find(op => op.name === `${APP}.discard`)?.result?.type, 'void');
  for (const [name, fieldName] of [['boundNullable', 'value'], ['boundArray', 'values']] as const) {
    const field: ArtifactOperationInput | undefined = compiled.operations?.find((op) => op.name === `${APP}.${name}`)?.inputs.fields.find((field) => field.name === fieldName);
    assert.equal(field?.computedDefault, true);
    assert.deepEqual(field?.field, { kind: 'integer' });
    assert.equal(field?.default, undefined);
  }
  const dir = await mkdtemp(join(tmpdir(), 'can-typed-scenarios-'));
  const world = await memberWorld();
  let d1: Awaited<ReturnType<typeof openD1>> | undefined;
  try {
    const asm = await assemble(compiled, join(dir, 'modules'));
    d1 = await openD1(join(dir, 'd1'));
    let invoker = buildInvoker(compiled, asm, d1.store, {
      memberships: world.memberships, now: () => FIXED_NOW,
    });
    const create = envelope('Counter.create', {});
    const born = committed(await invoker.invokeMutation(create, world.identity));
    assert.equal(born.result, null);
    assert.equal(born.records?.length, 1);
    const row = born.records![0] as { id: string; version: number; data: { count: string } };
    assert.equal(row.data.count, '1');
    assert.equal(row.version, 1);
    const ref = (version: number) => ({ id: row.id, version: String(version) });
    const receiptIdentity = (request: MutationEnvelope) => ({
      app: APP, owner: world.identity.team!.team_id, principal: world.identity.actor!.user_id,
      operation: asOperation(request.operation), operationId: asOperationId(request.operation_id),
    });
    const receipt = await d1.store.readReceipt(receiptIdentity(create));
    assert.equal(receipt?.resolvedDefaults['count'], '1');
    const defaultCounterOutcome = committed(await invoker.invokeMutation(
      envelope('Counter.create', { count: '7' }), world.identity));
    assert.equal(defaultCounterOutcome.result, null);
    assert.equal(defaultCounterOutcome.records?.length, 1);
    const defaultCounter = defaultCounterOutcome.records![0] as { id: string; version: number };
    const boundRef = { id: defaultCounter.id, version: String(defaultCounter.version) };
    // Genuine compiler-emitted read handler: native projected refs/defaults,
    // closed wire arrays and live by admission, without mutation identity.
    const readDescriptor = compiled.operations!.find(op => op.name === `${APP}.readBound`)!;
    assert.equal(readDescriptor.kind, 'read');
    assert.deepEqual(readDescriptor.result, { type: 'int[]' });
    assert.equal(readDescriptor.inputs.fields.find(field => field.name === 'values')?.computedDefault, true);
    const readRequest = { operation: `${APP}.readBound`, inputs: { counter: boundRef } };
    const beforeRead = await d1.store.readRevision();
    const beforeReadHistory = await d1.store.historyFor(MODEL, asId(defaultCounter.id));
    const readResult = async (inputs: Record<string, unknown> = readRequest.inputs) => {
      const outcome = await invoker.invokeRead({ ...readRequest, inputs }, world.identity);
      assert.ok('result' in outcome, JSON.stringify(outcome));
      return outcome.result;
    };
    assert.deepEqual(await readResult(), { result: ['7'], revision: beforeRead });
    assert.deepEqual(await readResult({ counter: boundRef, values: [] }), { result: [], revision: beforeRead });
    assert.deepEqual(await readResult({ counter: boundRef, values: ['9007199254740993'] }),
      { result: ['9007199254740993'], revision: beforeRead });
    assert.equal(Object.hasOwn(readRequest.inputs, 'values'), false);
    for (const inputs of [{ counter: boundRef, values: [9] }, { counter: boundRef, values: null },
      { counter: boundRef, extra: true }]) {
      const refusal = await invoker.invokeRead({ ...readRequest, inputs }, world.identity);
      assert.ok('error' in refusal);
      assert.equal(refusal.error.code, 'validation');
      assert.equal(Object.hasOwn(refusal.error, 'operation_id'), false);
    }
    const outsiderRead = await invoker.invokeRead(readRequest, world.outsider);
    assert.ok('error' in outsiderRead);
    assert.equal(outsiderRead.error.code, 'forbidden');
    assert.deepEqual(await invoker.invokeRead(readRequest, world.identity),
      { result: { result: ['7'], revision: beforeRead } });
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(defaultCounter.id)), beforeReadHistory);
    assert.equal(await d1.store.readRevision(), beforeRead);
    const modelRead = await invoker.invokeRead({ operation: `${MODEL}.read`, inputs: {} }, world.identity);
    assert.ok('result' in modelRead);
    const modelRecords = modelRead.result as { records: Array<{ id: string; data: { count: string } }>; revision: number };
    assert.equal(modelRecords.revision, beforeRead);
    assert.equal(modelRecords.records.find(item => item.id === defaultCounter.id)?.data.count, '7');
    // Synthetic adversarial wrapper around the real emitted read handler:
    // inspect the actual context and attempt each effect before delegating.
    const guardedRead = structuredClone(compiled);
    guardedRead.modules[0]!.js += `
const admittedReadCanApp = canApp;
canApp = function() {
  const registry = admittedReadCanApp();
  const read = registry["${APP}.readBound"];
  registry["${APP}.readBound"] = async function(c, inputs) {
    if (Object.hasOwn(c.operation, "id") || Object.hasOwn(c.canonical, "operationId"))
      throw new Error("read invented an operation identity");
    if (c.operation.source !== "test" || c.now.ms !== ${FIXED_NOW}n || c.clock() !== ${FIXED_NOW} ||
        c.actor.id !== "${world.identity.actor!.user_id}" || c.team.id !== "${world.identity.team!.team_id}")
      throw new Error("read context lost its admitted source facts");
    for (const effect of [
      () => c.store.commit({}), () => c.store.stageMigrationRows({}),
      () => c.store.query({}), () => c.store.load("${MODEL}", "private"),
      () => c.canonical.stageWrite({}), () => c.canonical.createRecord("${MODEL}", {}),
      () => c.canonical.setRecord(inputs.counter, {}), () => c.canonical.deleteRecord(inputs.counter, "remove"),
      () => c.sendDeferred("unbound.send", {}, "unbound"),
      () => c.scheduleDeferred("read", c.now, "unbound", {}, "${APP}"),
      () => c.cancelDeferred("read", "${APP}"),
    ]) {
      let refused = false;
      try { await effect(); } catch (error) {
        refused = error.code === "validation" && error.message.includes("Read scenarios cannot");
      }
      if (!refused) throw new Error("read effect or bypass reached its provider");
    }
    // Delivery observation is a viewer read, not an effect. The unbound
    // locator must still fail at its owning binding gate before a provider.
    let observationRefused = false;
    try { await c.canonical.observeDelivery({}, []); } catch (error) {
      observationRefused = error.code === "validation" &&
        error.message === "Delivery observation needs a record bound in this read scenario.";
    }
    if (!observationRefused) throw new Error("unbound delivery observation reached its provider");
    return read(c, inputs);
  };
  return registry;
};
`;
    const guardedAsm = await assemble(guardedRead, join(dir, 'guarded-read'));
    const guardedInvoker = buildInvoker(guardedRead, guardedAsm, d1.store, {
      memberships: world.memberships, now: () => FIXED_NOW, source: 'test',
    });
    assert.deepEqual(await guardedInvoker.invokeRead(readRequest, world.identity),
      { result: { result: ['7'], revision: beforeRead } });
    assert.equal(await d1.store.readRevision(), beforeRead);
    // Genuine source still owns its default; inherited artifact metadata cannot pair with it.
    const inheritedClaim = structuredClone(compiled);
    const inheritedField = inheritedClaim.operations!.find((op) => op.name === `${APP}.boundNullable`)!
      .inputs.fields.find((field) => field.name === 'value')!;
    assert.equal(Reflect.deleteProperty(inheritedField, 'computedDefault'), true);
    Object.setPrototypeOf(inheritedField, { computedDefault: true });
    assert.equal(Object.hasOwn(inheritedField, 'computedDefault'), false);
    const inheritedInvoker = buildInvoker(inheritedClaim, asm, d1.store, {
      memberships: world.memberships, now: () => FIXED_NOW,
    });
    const beforeInherited = await d1.store.readRevision();
    const inheritedRequest = envelope('boundNullable', { counter: boundRef });
    const inheritedRows = await d1.store.query({ model: MODEL, authority: 'owner', archived: 'include' });
    const inheritedHistory = await Promise.all(inheritedRows.map(row => d1!.store.historyFor(MODEL, row.id)));
    const inheritedReceipt = await d1.store.readReceipt(receiptIdentity(inheritedRequest));
    const inheritedRefusal = rejected(await inheritedInvoker.invokeMutation(inheritedRequest, world.identity));
    assert.equal(inheritedRefusal.message, 'importVerifiedAssemblyModule: artifact differs from assembled source');
    assert.equal(await d1.store.readRevision(), beforeInherited);
    assert.deepEqual(await d1.store.query({ model: MODEL, authority: 'owner', archived: 'include' }), inheritedRows);
    assert.deepEqual(await Promise.all(inheritedRows.map(row => d1!.store.historyFor(MODEL, row.id))), inheritedHistory);
    assert.deepEqual(await d1.store.readReceipt(receiptIdentity(inheritedRequest)), inheritedReceipt);
    assert.equal((await d1.store.load(MODEL, asId(defaultCounter.id)))?.version, 1);
    const nullableDefault = envelope('boundNullable', { counter: boundRef });
    const arrayDefault = envelope('boundArray', { counter: boundRef });
    assert.equal(committed(await invoker.invokeMutation(nullableDefault, world.identity)).result, '7');
    assert.deepEqual(committed(await invoker.invokeMutation(arrayDefault, world.identity)).result, ['7']);
    assert.equal(Object.hasOwn(nullableDefault.inputs, 'value'), false);
    assert.equal(Object.hasOwn(arrayDefault.inputs, 'values'), false);
    const nullableReceipt = await d1.store.readReceipt(receiptIdentity(nullableDefault));
    const arrayReceipt = await d1.store.readReceipt(receiptIdentity(arrayDefault));
    assert.ok(nullableReceipt?.inputHash);
    assert.ok(arrayReceipt?.inputHash);
    assert.equal(committed(await invoker.invokeMutation(envelope('boundNullable', {
      counter: boundRef, value: null,
    }), world.identity)).result, null);
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('boundArray', {
      counter: boundRef, values: [],
    }), world.identity)).result, []);
    assert.equal(committed(await invoker.invokeMutation(envelope('boundNullable', {
      counter: boundRef, value: '9',
    }), world.identity)).result, '9');
    assert.deepEqual(committed(await invoker.invokeMutation(envelope('boundArray', {
      counter: boundRef, values: ['9'],
    }), world.identity)).result, ['9']);
    rejected(await invoker.invokeMutation(envelope('boundNullable', { counter: boundRef, value: 9 }), world.identity), 'validation');
    rejected(await invoker.invokeMutation(envelope('boundArray', { counter: boundRef, values: [9] }), world.identity), 'validation');
    rejected(await invoker.invokeMutation({ ...nullableDefault, inputs: { counter: boundRef, value: null } }, world.identity), 'conflict');
    rejected(await invoker.invokeMutation({ ...arrayDefault, inputs: { counter: boundRef, values: [] } }, world.identity), 'conflict');
    const defaultRevision = await d1.store.readRevision();
    assert.equal(committed(await invoker.invokeMutation(nullableDefault, world.identity), 'replayed').result, '7');
    assert.deepEqual(committed(await invoker.invokeMutation(arrayDefault, world.identity), 'replayed').result, ['7']);
    assert.deepEqual(await d1.store.readReceipt(receiptIdentity(nullableDefault)), nullableReceipt);
    assert.deepEqual(await d1.store.readReceipt(receiptIdentity(arrayDefault)), arrayReceipt);
    assert.equal(await d1.store.readRevision(), defaultRevision);
    const bornRequest = envelope('born', {});
    assert.equal(committed(await invoker.invokeMutation(bornRequest, world.identity)).result, '2');
    const bornRows = await d1.store.query({ model: MODEL, authority: 'owner' });
    const createdInScenario = bornRows.find((candidate) => candidate.id !== row.id && candidate.id !== defaultCounter.id);
    assert.equal(createdInScenario?.data['count'], '2');
    assert.equal(createdInScenario?.version, 1);
    const bornReceipt = await d1.store.readReceipt(receiptIdentity(bornRequest));
    assert.equal(bornReceipt?.resolvedDefaults[`0:${MODEL}.count`], '1');
    assert.equal(bornReceipt?.outcome.status, 'committed');
    if (bornReceipt?.outcome.status === 'committed') assert.equal(bornReceipt.outcome.result, '2');

    // Both the admitted parameter and record getter must become native bigint.
    const increment = envelope('increment', { counter: ref(1), delta: '9007199254740993' });
    const large = committed(await invoker.invokeMutation(increment, world.identity));
    assert.equal(large.result, '9007199254740994');
    assert.equal((await d1.store.load(MODEL, asId(row.id)))?.data['count'], large.result);
    assert.equal(committed(await invoker.invokeMutation(increment, world.identity), 'replayed').result, large.result);
    assert.equal(committed(await invoker.invokeMutation(envelope('echo', {
      value: '9007199254740993',
    }), world.identity)).result, '9007199254740993');

    const twice = committed(await invoker.invokeMutation(envelope('twice', { counter: ref(2) }), world.identity));
    assert.equal(twice.result, '9007199254740996');
    const afterTwice = await d1.store.load(MODEL, asId(row.id));
    assert.equal(afterTwice?.version, 3);
    const history = await d1.store.historyFor(MODEL, asId(row.id));
    assert.deepEqual(history.slice(-2).map((entry) => entry.version), [3, 3]);
    assert.deepEqual(history.slice(-2).map((entry) => entry.after?.['count']), [
      '9007199254740995', '9007199254740996',
    ]);

    const finish = envelope('finish', { counter: ref(3) });
    const finished = committed(await invoker.invokeMutation(finish, world.identity));
    assert.ok(Object.hasOwn(finished, 'result'));
    assert.equal(finished.result, null);
    await replaysWithoutEffects(invoker, d1.store, finish, world.identity, null);
    assert.equal(committed(await invoker.invokeMutation(envelope('observedVersion', {
      counter: ref(4),
    }), world.identity)).result, '4');
    assert.equal((await d1.store.load(MODEL, asId(row.id)))?.version, 5);
    const beforeRefusal = await d1.store.load(MODEL, asId(row.id));
    const beforeHistory = await d1.store.historyFor(MODEL, asId(row.id));
    const rollback = envelope('rollback', { counter: ref(5), accept: false });
    rejected(await invoker.invokeMutation(rollback, world.identity));
    assert.deepEqual(await d1.store.load(MODEL, asId(row.id)), beforeRefusal);
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(row.id)), beforeHistory);
    rejected(await invoker.invokeMutation(envelope('increment', {
      counter: ref(1), delta: '1',
    }), world.identity), 'conflict');
    rejected(await invoker.invokeMutation(envelope('increment', {
      counter: ref(5), delta: '1',
    }), world.outsider), 'forbidden');
    assert.deepEqual(await d1.store.load(MODEL, asId(row.id)), beforeRefusal);
    assert.equal((await d1.store.readReceipt(receiptIdentity(finish)))?.outcome.status, 'committed');
    assert.doesNotThrow(() => JSON.stringify([large, twice, finished, receipt]));

    // Persisted supported replay must survive a physical reopen while its
    // original dependency row remains live and currently readable.
    await d1.worker.dispose(); d1 = undefined;
    d1 = await openD1(join(dir, 'd1'));
    invoker = buildInvoker(compiled, asm, d1.store, { memberships: world.memberships, now: () => FIXED_NOW });
    assert.deepEqual(await d1.store.load(MODEL, asId(row.id)), beforeRefusal);
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(row.id)), beforeHistory);
    await replaysWithoutEffects(invoker, d1.store, increment, world.identity, large.result);
    await replaysWithoutEffects(invoker, d1.store, finish, world.identity, null);
    await replaysWithoutEffects(invoker, d1.store, nullableDefault, world.identity, '7');
    await replaysWithoutEffects(invoker, d1.store, arrayDefault, world.identity, ['7']);

    const discard = envelope('discard', { counter: ref(5) });
    assert.equal(committed(await invoker.invokeMutation(discard, world.identity)).result, null);
    const archived = await d1.store.load(MODEL, asId(row.id));
    assert.equal(archived?.archivedAt, FIXED_NOW);
    assert.equal(archived?.version, 6);
    const archivedHistory = await d1.store.historyFor(MODEL, asId(row.id));
    assert.equal(archivedHistory.at(-1)?.change, 'archive');
    const archiveRefusal = rejected(await invoker.invokeMutation(envelope('increment', {
      counter: ref(6), delta: '1',
    }), world.identity), 'validation');
    assert.match(archiveRefusal.message, /Archived/);

    // Close and reopen the same on-disk D1 directory; do not reuse an instance.
    await d1.worker.dispose();
    d1 = undefined;
    d1 = await openD1(join(dir, 'd1'));
    const reopened = buildInvoker(compiled, asm, d1.store, {
      memberships: world.memberships, now: () => FIXED_NOW,
    });
    assert.deepEqual(await d1.store.load(MODEL, asId(row.id)), archived);
    assert.deepEqual(await d1.store.historyFor(MODEL, asId(row.id)), archivedHistory);
    const revision = await d1.store.readRevision();
    // Archiving ends the captured dependency's current readable lifetime;
    // a saved scalar cannot bypass that boundary after another physical reopen.
    const withheld = await replaysWithoutEffects(reopened, d1.store, increment, world.identity, null);
    assert.deepEqual(withheld.records, []);
    await replaysWithoutEffects(reopened, d1.store, finish, world.identity, null);
    assert.equal(committed(await reopened.invokeMutation(nullableDefault, world.identity), 'replayed').result, '7');
    assert.deepEqual(committed(await reopened.invokeMutation(arrayDefault, world.identity), 'replayed').result, ['7']);
    assert.deepEqual(await d1.store.readReceipt(receiptIdentity(nullableDefault)), nullableReceipt);
    assert.deepEqual(await d1.store.readReceipt(receiptIdentity(arrayDefault)), arrayReceipt);
    assert.equal(await d1.store.readRevision(), revision);
  } finally {
    await d1?.worker.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

// These are required genuine compiled replay criteria, including after physical D1 reopen.
// They await the owning Compiler Complete/effect-site proof; no synthetic association is installed.
for (const operation of ['born', 'discard'] as const) {
  test(`actual compiled ${operation} preserves successful receipt replay through D1 reopen`, async () => {
    const compiled = await artifact();
    const dir = await mkdtemp(join(tmpdir(), `can-typed-${operation}-replay-`));
    const world = await memberWorld();
    let d1: Awaited<ReturnType<typeof openD1>> | undefined;
    try {
      const asm = await assemble(compiled, join(dir, 'modules'));
      d1 = await openD1(join(dir, 'd1'));
      const invoker = buildInvoker(compiled, asm, d1.store, { memberships: world.memberships, now: () => FIXED_NOW });
      let inputs: MutationEnvelope['inputs'] = {};
      if (operation === 'discard') {
        const created = committed(await invoker.invokeMutation(envelope('Counter.create', { count: '7' }), world.identity));
        const original = created.records![0] as { id: string; version: number };
        inputs = { counter: { id: original.id, version: String(original.version) } };
      }
      const request = envelope(operation, inputs);
      const revision = await d1.store.readRevision();
      const outcome = committed(await invoker.invokeMutation(request, world.identity));
      const expectedResult = operation === 'born' ? '2' : null;
      assert.equal(outcome.result, expectedResult);
      assert.equal(await d1.store.readRevision(), revision + 1);
      const rows = await d1.store.query({ model: MODEL, authority: 'owner', archived: 'include' });
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.data['count'], operation === 'born' ? '2' : '7');
      assert.equal(row.version, operation === 'born' ? 1 : 2);
      assert.equal(row.archivedAt, operation === 'born' ? null : FIXED_NOW);
      const history = await d1.store.historyFor(MODEL, row.id);
      assert.deepEqual(history.map(entry => entry.change), operation === 'born' ? ['create', 'update'] : ['create', 'archive']);
      const receiptKey = { app: APP, owner: world.identity.team!.team_id, principal: world.identity.actor!.user_id,
        operation: asOperation(request.operation), operationId: asOperationId(request.operation_id) };
      const receipt = await d1.store.readReceipt(receiptKey);
      assert.equal(receipt?.outcome.status, 'committed');
      if (receipt?.outcome.status === 'committed') assert.equal(receipt.outcome.result, expectedResult);
      if (operation === 'born') assert.equal(receipt?.resolvedDefaults[`0:${MODEL}.count`], '1');
      await replaysWithoutEffects(invoker, d1.store, request, world.identity, expectedResult);
      const savedRevision = await d1.store.readRevision();
      await d1.worker.dispose(); d1 = undefined;
      d1 = await openD1(join(dir, 'd1'));
      assert.deepEqual(await d1.store.query({ model: MODEL, authority: 'owner', archived: 'include' }), rows);
      assert.deepEqual(await d1.store.historyFor(MODEL, row.id), history);
      assert.deepEqual(await d1.store.readReceipt(receiptKey), receipt);
      assert.equal(await d1.store.readRevision(), savedRevision);
      const reopened = buildInvoker(compiled, asm, d1.store, { memberships: world.memberships, now: () => FIXED_NOW });
      await replaysWithoutEffects(reopened, d1.store, request, world.identity, expectedResult);
    } finally {
      await d1?.worker.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('synthetic compatibility: absent result metadata keeps unknown bigint refusal', async () => {
  const legacy = await artifact();
  const descriptor = legacy.operations!.find((op) => op.name === `${APP}.echo`)!;
  delete (descriptor as { result?: unknown }).result;
  // Narrow synthetic historical variant; the persisted fixture remains compiler output.
  legacy.modules[0]!.js += `
delete appDefinition.operations["${APP}.echo"].result;
const originalCanApp = canApp;
canApp = function() {
  const registry = originalCanApp();
  delete registry.operations.find(operation => operation.name === "${APP}.echo").result;
  return registry;
};
`;
  const dir = await mkdtemp(join(tmpdir(), 'can-unknown-result-'));
  const world = await memberWorld();
  let d1: Awaited<ReturnType<typeof openD1>> | undefined;
  try {
    const asm = await assemble(legacy, join(dir, 'modules'));
    d1 = await openD1(join(dir, 'd1'));
    const invoker = buildInvoker(legacy, asm, d1.store, {
      memberships: world.memberships, now: () => FIXED_NOW,
    });
    const error = rejected(await invoker.invokeMutation(envelope('echo', {
      value: '9007199254740993',
    }), world.identity), 'rule_failed');
    assert.match(error.message, /JSON|bigint|BigInt/);
  } finally {
    await d1?.worker.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit-id helper compatibility stages through the same canonical execution', async () => {
  const compiled = await artifact();
  // Historical helper calls over actual model/admission metadata; not emitted Can code.
  compiled.modules[0]!.js += `
const explicitIdCanApp = canApp;
canApp = function() {
  const registry = explicitIdCanApp();
  registry["${APP}.born"] = async function(c) {
    const row = await create(c, "${MODEL}", {id: c.operation.id, data: {count: "2"}});
    const updated = await set(c, "${MODEL}", row.id, {count: "3"});
    await deleteRecord(c, "${MODEL}", row.id);
    return BigInt(updated.data.count);
  };
  return registry;
};
`;
  const dir = await mkdtemp(join(tmpdir(), 'can-explicit-id-'));
  try {
    const world = await memberWorld();
    const { store } = createTestMemoryStorage();
    const asm = await assemble(compiled, dir);
    const invoker = buildInvoker(compiled, asm, store, { memberships: world.memberships, now: () => FIXED_NOW });
    const request = envelope('born', {});
    assert.equal(committed(await invoker.invokeMutation(request, world.identity)).result, '3');
    const row = await store.load(MODEL, asId(request.operation_id));
    assert.equal(row?.data['count'], '3');
    assert.equal(row?.archivedAt, FIXED_NOW);
    assert.equal(row?.version, 1);
    assert.deepEqual((await store.historyFor(MODEL, asId(request.operation_id))).map(entry => entry.change), ['create', 'update', 'archive']);
    // Historical helper execution carries no supported original replay association.
    await refusesUnassociatedReplay(invoker, store, request, world.identity);
    // An object carrying a valid ID does not become a bound language record.
    const forged = await artifact();
    forged.modules[0]!.js += `
const forgedRecordCanApp = canApp;
canApp = function() {
  const registry = forgedRecordCanApp();
  registry["${APP}.born"] = async function(c) {
    await set(c, {id: "${request.operation_id}", version: 1n}, {count: 4n});
    return 4n;
  };
  return registry;
};
`;
    const forgedAsm = await assemble(forged, join(dir, 'forged'));
    const forgedInvoker = buildInvoker(forged, forgedAsm, store, { memberships: world.memberships, now: () => FIXED_NOW });
    const refusal = envelope('born', {});
    assert.match(rejected(await forgedInvoker.invokeMutation(refusal, world.identity), 'validation').message, /bound/);
    assert.equal((await store.load(MODEL, asId(request.operation_id)))?.data['count'], '3');
    assert.match(rejected(await forgedInvoker.invokeMutation(refusal, world.identity), 'validation').message, /bound/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
