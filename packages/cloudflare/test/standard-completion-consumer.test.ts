/** Unchanged Compiler private completion projection consumed through real
 * Identity/owner D1, State and Work. Sends and member seeds are explicitly
 * trusted host component setup; this does not qualify authored SEND, provider
 * authentication, public E6008 publication, or a whole application. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, ProviderBinding, ReceiptIdentity, StoragePort, WorkScope } from '@canlang/contracts';
import type { InstalledMailSender } from '@canlang/services';
import { EmailV1Adapter } from '@canlang/services/mail/adapter';
import { distribution } from '@canlang/values/distribution';
import { createSystemRegistry, systemCommandStageRevision, type SystemCommandDef } from '@canlang/state';
import { createD1OwnerRouter } from '@canlang/state/storage/owner-router';
import { ensureSchema } from '@canlang/state/storage/d1';
import { asId, asModel, asOperationId, seedRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { RECEIPT_MODEL, newReceiptRow, readReceiptRow, withReceiptRowData } from '@canlang/state/receipt/tables';
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { stageCanonicalSend } from '@canlang/work/kernel/dispatch-staging';
import { WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS, createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { WORK_DISPATCH_MODEL, WORK_OCCURRENCE_MODEL, WORK_SCHEDULE_MODEL, WORK_FANOUT_INTENT_MODEL,
  WORK_FANOUT_CHILD_MODEL, readDispatchRow, readOccurrenceRow, readFanoutIntentRow, readFanoutChildRow } from '@canlang/work/kernel/tables';
import { WORK_HANDLER_OCCURRENCE_MODEL, readHandlerOccurrenceRow } from '@canlang/work/kernel/handler-occurrence';
import { classifyFailure } from '@canlang/work/receipt';
import { attemptDispatch } from '@canlang/work/dispatch';
import { assembleModules, importVerifiedAssemblyModule } from '@canlang/cloudflare/runtime/modules';
import { createTeamOwnerStorageBoundary } from '@canlang/cloudflare/worker/assembly';
import { createBoundMailAdapter } from '@canlang/cloudflare/runtime/bound-mail';
import { createBoundMailDispatcher } from '@canlang/cloudflare/runtime/bound-dispatch';
import { createNativeStandardCompletionSourceCommand, invokeRetainedHandlerOccurrenceCanonical,
  createCanonicalCommittedCohortBody, loadFanoutStateProducers, readFanoutSchedulerProgress,
  runFanoutSchedulerTurn, type FenceAttemptDispatchFn } from '@canlang/cloudflare/runtime/invoke';
import { createBoundCohortTick } from '../dist/runtime/cohort-tick.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const APP = 'CompletionProjection', ENTRY = asModel(`${APP}.Entry`), EVENT = `${APP}.Primary.send.completed`;
const bounds = { maxSources: 8, maxHandlers: 8, maxMembers: 8, chunkSize: 2 };
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function snapshot(db: D1Database) {
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{ name: string }>();
  assert.equal(tables.success, true);
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const { name } of tables.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    result[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}

test('unchanged native private completion consumes original retained Email and frozen owner cohort in D1',
  { timeout: 120000 }, async () => {
    const fixtureRoot = process.env.CAN_STANDARD_COMPLETION_FIXTURE_ROOT ??
      join(root, 'compiler/target/standard-completion-private-qualification');
    const artifactPath = join(fixtureRoot, 'artifact.json'), sourcePath = join(fixtureRoot, 'completion-projection.can');
    const catalogPath = join(fixtureRoot, 'catalog.json');
    const originals = await Promise.all([artifactPath, sourcePath, catalogPath].map(path => readFile(path)));
    const artifact = JSON.parse(originals[0]!.toString('utf8')) as CompileArtifact;
    assert.equal(artifact.artifact_version, 1); assert.equal(artifact.modules.length, 1);
    assert.deepEqual(artifact.sources, [{ path: 'completion-projection.can', sha256: hash(originals[1]!) }]);
    assert.equal(hash(originals[2]!), hash(await readFile(fileURLToPath(distribution.catalog))), 'exact owning installed catalog');
    assert.deepEqual(artifact.operations, [], 'private source fixture retains the public publication refusal');
    const artifactJson = JSON.stringify(artifact), dir = await mkdtemp(join(tmpdir(), 'can-native-completion-consumer-'));
    let worker: Miniflare | undefined, sequence = 0;
    const clock = { nowMs: () => Date.now() }, nextId = () => asOperationId(uuidv7(clock.nowMs(), ++sequence));
    const sends: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/send') { response.writeHead(404); response.end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); sends.push(body);
      assert.equal(request.headers['idempotency-key'], body['delivery_id']);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ reference: `accepted-${body['delivery_id']}` }));
    });
    let listening = false;
    try {
      const asm = await assembleModules({ artifact, sourcePath }, { workDir: join(dir, 'modules'),
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      const namespace = object(await importVerifiedAssemblyModule(asm, artifact.modules[0]!.path, artifact));
      const definition = object(namespace['appDefinition']);
      const expectedCensus = [
        { source: 'std.EmailV1.send', event: EVENT, binding: `${APP}.Primary`, from: 'deployment.primary', resultType: 'EmailAccepted',
          handlers: [`${APP}.primary_first`, `${APP}.primary_cohort`, `${APP}.primary_last`] },
        { source: 'std.EmailV1.send', event: `${APP}.Secondary.send.completed`, binding: `${APP}.Secondary`, from: 'deployment.secondary',
          resultType: 'EmailAccepted', handlers: [`${APP}.secondary`] },
        { source: 'std.PaymentsV1.cancel', event: `${APP}.Cash.cancel.completed`, binding: `${APP}.Cash`, from: 'deployment.cash',
          resultType: 'PaymentState', handlers: [`${APP}.cash`] },
        { source: 'std.TextGenerationV1.generate', event: `${APP}.LLM.generate.completed`, binding: `${APP}.LLM`, from: 'deployment.llm',
          resultType: 'TextRun', handlers: [`${APP}.text_result`] },
        { source: 'std.ImagesV1.submit', event: `${APP}.Images.submit.completed`, binding: `${APP}.Images`, from: 'deployment.images',
          resultType: 'ImageRun', handlers: [`${APP}.image_result`] },
      ];
      assert.deepEqual(definition['standardCompletions'], expectedCensus);
      assert.deepEqual(artifact.callables.map(callable => callable.id),
        [`${APP}.primary_first`, `${APP}.secondary`, `${APP}.primary_cohort`, `${APP}.primary_last`, `${APP}.cash`, `${APP}.text_result`, `${APP}.image_result`]);
      assert.deepEqual(object(definition['cohorts'])[`${APP}.primary_cohort`], { kind: 'model', model: ENTRY, bind: 'entry' });
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: { IDENTITY: 'completion-identity', A: 'completion-owner-a', B: 'completion-owner-b' }, d1Persist: join(dir, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const dbA = await worker.getD1Database('A') as unknown as D1Database, dbB = await worker.getD1Database('B') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(dbA); await ensureSchema(dbB);
      const identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' }), otherTeam = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: 'completion-owner@example.test', password_hash: 'unused', email_verified: true });
      await identities.createMembership({ user_id: user.user_id, team_id: team.team_id, is_owner: true, roles: [] });
      const token = randomBytes(32).toString('hex');
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        expires_at: new Date(clock.nowMs() + 3600000).toISOString(), last_team_id: team.team_id });
      const identity = await resolveIdentity(identities, { session_token: token }, { clock });
      const scope: WorkScope = { app: APP, owner: team.team_id, ownerPackage: APP }, foreignScope = { ...scope, owner: otherTeam.team_id };
      const boundary = await createTeamOwnerStorageBoundary({ artifact, asm, app: APP, identities,
        router: createD1OwnerRouter({ resolveBinding: selected => selected.app === APP &&
          [team.team_id, otherTeam.team_id].includes(selected.owner) ? {
            ...selected, db: selected.owner === team.team_id ? dbA : dbB, initializeFresh: true,
          } : null }) });
      const store = await boundary.forIdentity(identity), foreign = await boundary.forTrustedScope(foreignScope, clock.nowMs());
      const batches: Parameters<StoragePort['commit']>[0][] = [];
      const observed: StoragePort = { ...store, commit: async batch => { batches.push(structuredClone(batch)); return store.commit(batch); } };
      const all = async () => ({ a: await snapshot(dbA), b: await snapshot(dbB), identity: await snapshot(identityDb) });
      const isolated = { b: await snapshot(dbB), identity: await snapshot(identityDb) };
      const query = (model: string) => store.query({ model: asModel(model), authority: 'owner', archived: 'include', order: [{ field: 'id', direction: 'asc' }] });
      const memberIds = ['a', 'b', 'c'];
      for (const id of memberIds) await seedRow(observed, ENTRY, { id, data: { seen: id }, createdBy: user.user_id, updatedBy: user.user_id });
      const domainBefore = await query(ENTRY), historyBefore = await Promise.all(memberIds.map(id => store.historyFor(ENTRY, asId(id))));
      const native = await createNativeStandardCompletionSourceCommand({ asm, artifact, scope, identities, bounds });
      const sourceRegistry = createSystemRegistry([native]);
      const read = (selected: StoragePort = observed) => sourceRegistry.read(native.name, { deliveryId },
        { actor: user.user_id, now: clock.nowMs(), operation: EVENT, operationId: 'completion-read' }, { store: selected });
      let deliveryId = '';
      const originId = nextId(), mailInput = { to: 'recipient@example.test', subject: 'Native completion', body: 'Local retained Email', attachments: [] };
      const send: SystemCommandDef = { name: 'component.completion.send', stage: async (_args, ctx) => {
        const staged = await stageCanonicalSend({ operationId: originId, source: 'std.EmailV1.send', occurrenceIndex: 0,
          request: { binding: `${APP}.Primary`, from: 'deployment.primary', arguments: mailInput }, originOccurrence: null }, ctx);
        const receipt = newReceiptRow({ deliveryId: staged.delivery.id, revision: systemCommandStageRevision(ctx) + 1,
          status: 'pending', result: null, error: null, contentRef: null, resultExpiresAtMs: null }, { nowMs: ctx.now, actor: ctx.actor });
        return { ...staged.effects, writes: [...staged.effects.writes ?? [], { kind: 'insert', model: asModel(RECEIPT_MODEL), row: receipt }],
          result: { deliveryId: staged.delivery.id } };
      } };
      const sent = await createSystemRegistry([send]).run(send.name, {},
        { actor: user.user_id, now: clock.nowMs(), operation: send.name, operationId: originId }, { store: observed });
      deliveryId = String(object(sent.result)['deliveryId']);
      const original = await store.outboxGet(deliveryId); assert.ok(original?.originalCommit);
      assert.equal(original.intent.operationId, originId); assert.equal(original.intent.target, 'std.EmailV1.send');
      assert.deepEqual(original.intent.arguments, { binding: `${APP}.Primary`, from: 'deployment.primary', arguments: mailInput });
      const initialDispatch = await store.load(WORK_DISPATCH_MODEL, asId(deliveryId)); assert.ok(initialDispatch);
      assert.equal(readDispatchRow(initialDispatch).operationId, originId);
      await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); }); listening = true;
      const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
      const binding: ProviderBinding = { deployment: 'deployment.primary', capability: 'std.EmailV1', capabilityVersion: 1, account: 'local-completion-test' };
      const installed: InstalledMailSender = { binding, mail: new EmailV1Adapter({ baseUrl: `http://127.0.0.1:${address.port}`,
        timeoutMs: 2000, maxBodyBytes: 16384, maxTransportBytes: null, clock: { now: clock.nowMs } }) };
      const adapter = createBoundMailAdapter({ appDefinition: definition, binding,
        resolveInstalledMailSender: deployment => { assert.equal(deployment, binding.deployment); return installed; } });
      const dispatcher = await createBoundMailDispatcher({ store: observed, adapter, workCommands: WORK_SYSTEM_COMMANDS,
        stageCommands: WORK_DISPATCH_STAGE_COMMANDS, createClaimCommand: createWorkDispatchClaimCommand });
      const delivered = await dispatcher.drive({ intentId: deliveryId, actor: user.user_id, operation: 'component.completion.drive',
        nowMs: clock.nowMs, nextClaimId: () => `claim-${++sequence}`, maxClaimAgeMs: 60000,
        claimOperationId: nextId(), recordOperationId: nextId(), classifyFailure, evaluateGuard: () => true, readStateSnapshot: () => null,
        fence: { owner: team.team_id, attemptDispatch: attemptDispatch as FenceAttemptDispatchFn,
          revalidateAuthority: async () => (await identities.findMembership(team.team_id, user.user_id))?.is_owner === true } });
      assert.equal(delivered.status, 'recorded'); assert.equal(sends.length, 1);
      assert.deepEqual(sends[0], { ...mailInput, delivery_id: deliveryId });
      const terminalRow = await store.load(asModel(RECEIPT_MODEL), asId(deliveryId)); assert.ok(terminalRow);
      const terminal = readReceiptRow(terminalRow); assert.equal(terminal.receipt.status, 'succeeded');
      assert.deepEqual(terminal.receipt.result, { reference: `accepted-${deliveryId}` });
      const beforeMissing = await all(); await assert.rejects(read(), /has not been consumed/); assert.deepEqual(await all(), beforeMissing);
      const beforeIssue = batches.length, revision = await store.readRevision(), sourceBefore = await snapshot(dbA);
      const issued = await sourceRegistry.run(native.name, { deliveryId },
        { actor: user.user_id, now: clock.nowMs(), operation: EVENT, operationId: nextId() }, { store: observed });
      assert.equal(object(issued.result)['status'], 'staged'); assert.equal(batches.length, beforeIssue + 1);
      assert.equal(issued.revision, Number(revision) + 1);
      const sourceBatch = batches.at(-1)!;
      assert.equal(sourceBatch.receipt, null); assert.deepEqual(sourceBatch.history, []);
      assert.deepEqual(sourceBatch.outbox, []); assert.deepEqual(sourceBatch.schedules, []);
      assert.deepEqual(sourceBatch.uniqueClaims, []); assert.deepEqual(sourceBatch.uniqueReleases, []);
      assert.equal(sourceBatch.writes.some(write => write.model === ENTRY || write.kind !== 'insert'), false);
      const sourceAfter = await snapshot(dbA), sourceLogs = sourceAfter['fence_log']!;
      assert.equal(sourceLogs.filter(row => row['revision'] === issued.revision).length, 1);
      assert.equal(sourceLogs.length, sourceBefore['fence_log']!.length + 1);
      assert.deepEqual(sourceLogs.filter(row => row['revision'] !== issued.revision), sourceBefore['fence_log']);
      const sourceOccurrence = String(object(issued.result)['sourceOccurrence']);
      const payload = { delivery_id: deliveryId, status: 'succeeded', result: terminal.receipt.result, error: null };
      assert.deepEqual(object(issued.result)['payload'], payload);
      const consumedRow = await store.load(WORK_OCCURRENCE_MODEL, asId(sourceOccurrence)); assert.ok(consumedRow);
      const consumed = readOccurrenceRow(consumedRow), consumedResult = object(consumed.result);
      assert.equal(consumedResult['kind'], 'standard-completion-source'); assert.equal(consumedResult['event'], EVENT);
      assert.deepEqual(object(consumedResult['definition'])['scope'], scope);
      assert.deepEqual(object(consumedResult['origin'])['intent'], original.intent);
      assert.deepEqual(object(consumedResult['origin'])['originalCommit'], original.originalCommit);
      const routes = consumedResult['handlers'] as Record<string, unknown>[];
      assert.deepEqual(routes.map(route => route['handler']), expectedCensus[0]!.handlers);
      const intents = await query(WORK_FANOUT_INTENT_MODEL); assert.equal(intents.length, 1);
      const intent = readFanoutIntentRow(intents[0]!); assert.deepEqual(intent.members, memberIds);
      assert.equal(intent.sourceOccurrence, sourceOccurrence); assert.equal(intent.handler, `${APP}.primary_cohort`);
      assert.equal((await query(WORK_FANOUT_CHILD_MODEL)).length, 2, 'owning source admits only its first chunk');
      assert.deepEqual(await query(WORK_SCHEDULE_MODEL), []);
      await seedRow(observed, ENTRY, { id: 'late', data: { seen: 'late' }, createdBy: user.user_id, updatedBy: user.user_id });
      const domainWithLate = await query(ENTRY);
      const expire: SystemCommandDef = { name: 'component.completion.expire', stage: async (_args, ctx) => {
        const row = await ctx.load(asModel(RECEIPT_MODEL), asId(deliveryId)); assert.ok(row);
        const value = readReceiptRow(row);
        return { writes: [{ kind: 'update', model: asModel(RECEIPT_MODEL), id: row.id, expectedVersion: row.version,
          row: withReceiptRowData(row, { ...value.receipt, contentRef: value.contentRef, resultExpiresAtMs: 0 }, { nowMs: ctx.now, actor: ctx.actor }) }] };
      } };
      await createSystemRegistry([expire]).run(expire.name, {},
        { actor: user.user_id, now: clock.nowMs(), operation: expire.name, operationId: nextId() }, { store: observed });
      const beforeRead = await all(), beforeReadBatches = batches.length;
      let censusReads = 0, currentReceiptReads = 0;
      const readonlyStore: StoragePort = { ...observed, query: async spec => { censusReads++; return observed.query(spec); },
        load: async (model, id) => { if (model === RECEIPT_MODEL) currentReceiptReads++; return observed.load(model, id); } };
      const retainedRead = await read(readonlyStore); assert.deepEqual(retainedRead.result, consumed);
      assert.ok(Object.isFrozen(retainedRead.result)); assert.equal(censusReads, 0); assert.equal(currentReceiptReads, 0);
      assert.equal(batches.length, beforeReadBatches); assert.deepEqual(await all(), beforeRead);
      const selector = { sourceOccurrence, handler: `${APP}.primary_first`, event: EVENT, scope };
      const ordinary = { artifact, asm, app: APP, selector, store: observed, identities, now: clock.nowMs };
      const noEffects = async (work: () => Promise<unknown>, expected: RegExp) => {
        const before = await all(), writes = batches.length;
        await assert.rejects(work(), expected); assert.equal(batches.length, writes); assert.deepEqual(await all(), before);
      };
      await noEffects(() => createNativeStandardCompletionSourceCommand({ asm, artifact, scope, identities, bounds: { ...bounds, chunkSize: 1 } }), /original native host installation/);
      await noEffects(() => invokeRetainedHandlerOccurrenceCanonical({ ...ordinary, selector: { ...selector, scope: foreignScope }, store: foreign.store }), /installation/);
      await noEffects(() => invokeRetainedHandlerOccurrenceCanonical({ ...ordinary, asm: { ...asm } }), /assembly|assembler|correspondence|source/i);
      const uninstalledArtifact = JSON.parse(originals[0]!.toString('utf8')) as CompileArtifact;
      const fresh = await assembleModules({ artifact: uninstalledArtifact, sourcePath }, { workDir: join(dir, 'uninstalled'),
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      await noEffects(() => invokeRetainedHandlerOccurrenceCanonical({ ...ordinary, artifact: uninstalledArtifact, asm: fresh }), /original native host installation/);
      const originalSha = artifact.sources[0]!.sha256;
      try { artifact.sources[0]!.sha256 = '0'.repeat(64); await noEffects(() => read(), /assembly|artifact|correspondence|source/i); }
      finally { artifact.sources[0]!.sha256 = originalSha; }
      const modulePath = fileURLToPath(asm.moduleUrls[artifact.modules[0]!.path]!); const originalJs = await readFile(modulePath);
      try { await writeFile(modulePath, Buffer.concat([originalJs, Buffer.from('\n// changed staged source\n')]));
        await noEffects(() => read(), /assembly|module|correspondence|source/i); }
      finally { await writeFile(modulePath, originalJs); }
      for (const handler of [`${APP}.primary_first`, `${APP}.primary_last`]) {
        const before = batches.length;
        assert.equal(object(await invokeRetainedHandlerOccurrenceCanonical({ ...ordinary, selector: { ...selector, handler } }))['status'], 'completed');
        assert.equal(batches.length, before + 1); assert.ok(batches.at(-1)!.receipt);
        assert.equal(batches.at(-1)!.receipt!.identity.operation, handler);
        assert.equal(batches.at(-1)!.receipt!.committedRevision, Number(batches.at(-1)!.expectedRevision) + 1);
        assert.equal(batches.at(-1)!.writes.some(write => write.model === ENTRY), false);
        const snapshotBefore = await all(), replayBatches = batches.length;
        assert.equal(object(await invokeRetainedHandlerOccurrenceCanonical({ ...ordinary, selector: { ...selector, handler } }))['status'], 'replayed');
        assert.equal(batches.length, replayBatches); assert.deepEqual(await all(), snapshotBefore);
      }
      const generated = await createCanonicalCommittedCohortBody({ artifact, asm, app: APP, handler: `${APP}.primary_cohort`,
        source: { occurrenceId: sourceOccurrence, event: EVENT, scope }, store: observed, identities, now: clock.nowMs });
      assert.equal(generated.identity.actor, null); assert.equal(generated.identity.team?.team_id, team.team_id);
      const producers = await loadFanoutStateProducers();
      const tick = await createBoundCohortTick({ artifact, asm, identities, ownerStorage: boundary, scope, now: clock.nowMs });
      for (let turn = 0; ; turn++) {
        assert.ok(turn < 12, 'bounded real retained tick settles the original three members');
        await tick.tick();
        const progress = await readFanoutSchedulerProgress({ store, fanoutId: generated.fanoutId, pageLimit: 4, producers });
        if (progress.terminal) { assert.equal(progress.completed, 3); assert.equal(progress.failed, 0); break; }
      }
      const children = (await query(WORK_FANOUT_CHILD_MODEL)).map(readFanoutChildRow);
      assert.deepEqual(children.map(child => child.recordId).sort(), memberIds);
      assert.ok(children.every(child => child.state === 'completed' && child.parentOccurrence === sourceOccurrence));
      assert.deepEqual(readFanoutIntentRow((await store.load(WORK_FANOUT_INTENT_MODEL, intents[0]!.id))!).members, memberIds);
      assert.deepEqual((await query(ENTRY)).filter(row => row.id !== 'late'), domainBefore);
      assert.deepEqual(await query(ENTRY), domainWithLate, 'noop emitted bodies cannot change even the late excluded row');
      assert.deepEqual(await Promise.all(memberIds.map(id => store.historyFor(ENTRY, asId(id)))), historyBefore);
      assert.deepEqual(await store.historyFor(ENTRY, asId('late')), []);
      const receipts = await dbA.prepare('SELECT app, owner, principal, operation, operation_id AS operationId FROM receipts ORDER BY operation_id').all<ReceiptIdentity>();
      assert.equal(receipts.results.length, 5, 'two ordinary and three cohort canonical invocation receipts');
      for (const identity of receipts.results) {
        assert.ok([`${APP}.primary_first`, `${APP}.primary_last`, `${APP}.primary_cohort`].includes(identity.operation));
        const saved = await store.readReceipt(identity); assert.ok(saved); assert.equal(saved.outcome.status, 'committed');
        assert.equal(saved.identity.app, APP); assert.equal(saved.identity.owner, scope.owner);
      }
      const replayBefore = await all(), idsBefore = sequence, writesBefore = batches.length;
      let cursor: string | null = null; const replayed: string[] = [];
      for (let page = 0; ; page++) {
        assert.ok(page < 3);
        const turn = await runFanoutSchedulerTurn({ store: observed, fanoutId: generated.fanoutId, cursor,
          bounds: { pageLimit: 2, maxDrives: 2 }, policy: { maxAttempts: 3, horizonMs: 60000 }, meta: { actor: generated.trustedSource, nowMs: clock.nowMs() },
          maxClaimAgeMs: 60000, cohort: { model: generated.cohort.model },
          freeze: { cutoff: { sourceOccurrence, handler: `${APP}.primary_cohort` }, cohort: generated.cohort, owner: team.team_id,
            bounds: { ...generated.bounds, maxAttempts: 3 } }, guard: { predicate: null, frozenInputs: null }, evaluateGuard: () => true,
          readSnapshot: (_child, row) => row, fenceFor: () => ({ owner: team.team_id,
            revalidateAuthority: async () => (await identities.findTeamById(team.team_id)) !== null }), body: generated.body, producers,
          invoke: { registry: generated.registry, memberships: identities, clock, identity: generated.identity, app: APP,
            source: 'schedule', childOperation: `${APP}.primary_cohort`, refInput: generated.refInput, inputs: generated.inputs,
            kind: 'trusted', trustedSource: generated.trustedSource, operationIdFor: nextId } });
        assert.equal(turn.status, 'turn'); if (turn.status !== 'turn') throw new Error('retained terminal turn absent');
        assert.ok(turn.driven.every(child => child.status === 'replayed')); replayed.push(...turn.driven.map(child => child.recordId));
        if (turn.done) break; assert.ok(turn.cursor); cursor = turn.cursor;
      }
      assert.deepEqual(replayed, memberIds); assert.equal(sequence, idsBefore); assert.equal(batches.length, writesBefore);
      assert.deepEqual(await read().then(value => value.result), consumed); assert.deepEqual(await all(), replayBefore);
      assert.deepEqual(await query(WORK_SCHEDULE_MODEL), []); assert.equal(sends.length, 1);
      const finalOutbox = await store.outboxGet(deliveryId); assert.ok(finalOutbox);
      assert.equal(finalOutbox.status, 'dispatched'); assert.deepEqual(finalOutbox.intent, original.intent);
      assert.deepEqual(finalOutbox.originalCommit, original.originalCommit);
      assert.deepEqual({ b: await snapshot(dbB), identity: await snapshot(identityDb) }, isolated);
      assert.ok((await query(WORK_HANDLER_OCCURRENCE_MODEL)).map(readHandlerOccurrenceRow).every(route => route.state === 'completed'));
      assert.equal(JSON.stringify(artifact), artifactJson);
      assert.deepEqual(await Promise.all([artifactPath, sourcePath, catalogPath].map(path => readFile(path))), originals);
    } finally {
      if (listening) { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
      if (worker !== undefined) await worker.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
