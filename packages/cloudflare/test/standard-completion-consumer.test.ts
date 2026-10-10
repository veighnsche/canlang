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
import { hashInputs } from '@canlang/state/invocation/replay';
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
const APP = 'CompletionProjection', ENTRY = asModel(`${APP}.Entry`), AUDIT = asModel(`${APP}.CompletionAudit`), EVENT = `${APP}.Primary.send.completed`;
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
    assert.equal(hash(originals[1]!), '45621cc809a9576c84381c9439b7383d7b87c0e322d9444ed2a58e3fece60139',
      'exact released effectful private source, consumed unchanged');
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
      if (body['subject'] === 'Rejected native completion') {
        response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'rejected' })); return;
      }
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
      const observeStore = (selected: StoragePort): StoragePort => ({ ...selected, commit: async batch => {
        batches.push(structuredClone(batch)); return selected.commit(batch);
      } });
      const observed = observeStore(store);
      const observedBoundary = { ...boundary, async forTrustedScope(selected: WorkScope, now: number) {
        const original = await boundary.forTrustedScope(selected, now);
        return { ...original, store: observeStore(original.store) };
      } };
      const all = async () => ({ a: await snapshot(dbA), b: await snapshot(dbB), identity: await snapshot(identityDb) });
      const isolated = { b: await snapshot(dbB), identity: await snapshot(identityDb) };
      const query = (model: string) => store.query({ model: asModel(model), authority: 'owner', archived: 'include', order: [{ field: 'id', direction: 'asc' }] });
      const memberIds = ['a', 'b', 'c'];
      for (const id of memberIds) await seedRow(observed, ENTRY, { id, data: { seen: id }, createdBy: user.user_id, updatedBy: user.user_id });
      const domainBefore = await query(ENTRY), historyBefore = await Promise.all(memberIds.map(id => store.historyFor(ENTRY, asId(id))));
      assert.deepEqual(await query(AUDIT), []);
      const native = await createNativeStandardCompletionSourceCommand({ asm, artifact, scope, identities, bounds });
      const sourceRegistry = createSystemRegistry([native]);
      const read = (selected: StoragePort = observed) => sourceRegistry.read(native.name, { deliveryId },
        { actor: user.user_id, now: clock.nowMs(), operation: EVENT, operationId: 'completion-read' }, { store: selected });
      let deliveryId = '';
      const originId = nextId(), mailInput = { to: 'recipient@example.test', subject: 'Native completion', body: 'Local retained Email', attachments: [] };
      const sendDelivery = async (operationId: ReturnType<typeof nextId>, input: typeof mailInput) => {
        const send: SystemCommandDef = { name: 'component.completion.send', stage: async (_args, ctx) => {
          const staged = await stageCanonicalSend({ operationId, source: 'std.EmailV1.send', occurrenceIndex: 0,
            request: { binding: `${APP}.Primary`, from: 'deployment.primary', arguments: input }, originOccurrence: null }, ctx);
          const receipt = newReceiptRow({ deliveryId: staged.delivery.id, revision: systemCommandStageRevision(ctx) + 1,
            status: 'pending', result: null, error: null, contentRef: null, resultExpiresAtMs: null }, { nowMs: ctx.now, actor: ctx.actor });
          return { ...staged.effects, writes: [...staged.effects.writes ?? [], { kind: 'insert', model: asModel(RECEIPT_MODEL), row: receipt }],
            result: { deliveryId: staged.delivery.id } };
        } };
        return createSystemRegistry([send]).run(send.name, {},
          { actor: user.user_id, now: clock.nowMs(), operation: send.name, operationId }, { store: observed });
      };
      const sent = await sendDelivery(originId, mailInput);
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
      const assertBodyReceipt = async (batch: Parameters<StoragePort['commit']>[0], handler: string) => {
        assert.ok(batch.receipt); assert.equal(batch.receipt.identity.app, APP);
        assert.equal(batch.receipt.identity.owner, team.team_id);
        assert.equal(batch.receipt.identity.principal, `completion:${EVENT}`);
        assert.equal(batch.receipt.identity.operation, handler);
        assert.equal(batch.receipt.committedRevision, Number(batch.expectedRevision) + 1);
        assert.deepEqual(await store.readReceipt(batch.receipt.identity), batch.receipt);
        assert.deepEqual((await dbA.prepare('SELECT revision,at,operation FROM fence_log WHERE revision=?')
          .bind(batch.receipt.committedRevision).all()).results,
        [{ revision: batch.receipt.committedRevision, at: batch.receipt.createdAt, operation: handler }]);
        for (const key of ['outbox', 'schedules', 'uniqueClaims', 'uniqueReleases', 'outboxAck'] as const)
          assert.deepEqual(batch[key] ?? [], [], `${handler}: no unrelated ${key}`);
        for (const history of batch.history) {
          assert.equal(history.operation, handler); assert.equal(history.operationId, batch.receipt.identity.operationId);
          assert.equal(history.actor, `completion:${EVENT}`); assert.equal(history.at, batch.receipt.createdAt);
        }
      };
      const assertUnrelatedTables = (before: Awaited<ReturnType<typeof all>>, after: Awaited<ReturnType<typeof all>>) => {
        assert.deepEqual(after.b, before.b); assert.deepEqual(after.identity, before.identity);
        assert.deepEqual(Object.keys(after.a), Object.keys(before.a));
        for (const table of Object.keys(before.a))
          if (!['records', 'history', 'receipts', 'fence', 'fence_log', 'sqlite_sequence'].includes(table))
            assert.deepEqual(after.a[table], before.a[table], `${table}: body leaves every unrelated table unchanged`);
      };
      for (const handler of [`${APP}.primary_first`, `${APP}.primary_last`]) {
        const before = batches.length, revisionBefore = await store.readRevision(), resourcesBefore = await all();
        assert.equal(object(await invokeRetainedHandlerOccurrenceCanonical({ ...ordinary, selector: { ...selector, handler } }))['status'], 'completed');
        assert.equal(batches.length, before + 1); assert.ok(batches.at(-1)!.receipt);
        const batch = batches.at(-1)!; await assertBodyReceipt(batch, handler);
        assert.equal(await store.readRevision(), Number(revisionBefore) + 1);
        assert.equal(batch.receipt!.outcome.status, 'committed');
        const business = batch.writes.filter(write => write.model === AUDIT || write.model === ENTRY);
        if (handler === `${APP}.primary_first`) {
          assert.equal(business.length, 1); const write = business[0]!; assert.equal(write.kind, 'insert');
          if (write.kind !== 'insert') throw new Error('Original ordinary body did not create its Audit');
          assert.equal(write.model, AUDIT); assert.equal(write.row.version, 1);
          assert.deepEqual(write.row.data, { delivery: deliveryId, reference: `accepted-${deliveryId}` });
          assert.deepEqual(await store.load(AUDIT, write.row.id), write.row);
          assert.deepEqual(await query(AUDIT), [write.row]);
          assert.equal(write.row.created, batch.receipt!.createdAt); assert.equal(write.row.updated, batch.receipt!.createdAt);
          assert.equal(write.row.createdBy, `completion:${EVENT}`); assert.equal(write.row.updatedBy, `completion:${EVENT}`);
          assert.equal(batch.history.length, 1);
          const history = batch.history[0]!; assert.equal(history.model, AUDIT); assert.equal(history.recordId, write.row.id);
          assert.equal(history.version, 1); assert.equal(history.change, 'create'); assert.equal(history.before, null);
          assert.deepEqual(history.after, write.row.data); assert.deepEqual(await store.historyFor(AUDIT, write.row.id), batch.history);
          assert.ok(batch.receipt!.outcome.status === 'committed');
          assert.deepEqual(batch.receipt!.outcome.recordVersions.filter(row => row.model === AUDIT || row.model === ENTRY),
            [{ model: AUDIT, id: write.row.id, version: 1 }]);
        } else { assert.deepEqual(business, []); assert.deepEqual(batch.history, []); }
        const framework = batch.writes.filter(write => write.model !== AUDIT && write.model !== ENTRY);
        assert.deepEqual(framework.map(write => [write.model, write.kind]),
          [[WORK_HANDLER_OCCURRENCE_MODEL, 'update'], [WORK_OCCURRENCE_MODEL, 'insert']]);
        const resourcesAfter = await all(); assertUnrelatedTables(resourcesBefore, resourcesAfter);
        assert.equal(resourcesAfter.a['receipts']!.length, resourcesBefore.a['receipts']!.length + 1);
        assert.equal(resourcesAfter.a['fence_log']!.length, resourcesBefore.a['fence_log']!.length + 1);
        assert.equal(resourcesAfter.a['history']!.length, resourcesBefore.a['history']!.length + batch.history.length);
        const priorSeq = resourcesBefore.a['history']!.reduce((max, row) => Math.max(max, Number(row['seq'])), 0);
        assert.deepEqual(resourcesAfter.a['history']!.filter(row => Number(row['seq']) <= priorSeq), resourcesBefore.a['history']);
        assert.deepEqual(resourcesAfter.a['receipts']!.filter(row => row['operation_id'] !== batch.receipt!.identity.operationId),
          resourcesBefore.a['receipts']);
        assert.deepEqual(resourcesAfter.a['fence_log']!.filter(row => row['revision'] !== batch.receipt!.committedRevision),
          resourcesBefore.a['fence_log']);
        const changedKeys = new Set(batch.writes.map(write => `${write.model}\0${write.kind === 'remove' ? write.id : write.row.id}`));
        const untouched = (rows: Record<string, unknown>[]) => rows.filter(row => !changedKeys.has(`${row['model']}\0${row['id']}`));
        assert.deepEqual(untouched(resourcesAfter.a['records']!), untouched(resourcesBefore.a['records']!));
        assert.deepEqual(await query(ENTRY), domainWithLate);
        const snapshotBefore = await all(), replayBatches = batches.length;
        assert.equal(object(await invokeRetainedHandlerOccurrenceCanonical({ ...ordinary, selector: { ...selector, handler } }))['status'], 'replayed');
        assert.equal(batches.length, replayBatches); assert.deepEqual(await all(), snapshotBefore);
      }
      const generated = await createCanonicalCommittedCohortBody({ artifact, asm, app: APP, handler: `${APP}.primary_cohort`,
        source: { occurrenceId: sourceOccurrence, event: EVENT, scope }, store: observed, identities, now: clock.nowMs });
      assert.equal(generated.identity.actor, null); assert.equal(generated.identity.team?.team_id, team.team_id);
      const producers = await loadFanoutStateProducers();
      const tick = await createBoundCohortTick({ artifact, asm, identities, ownerStorage: observedBoundary, scope, now: clock.nowMs });
      const beforeCohort = await all(), auditsBeforeCohort = await query(AUDIT), firstCohortBatch = batches.length;
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
      const cohortBatches = batches.slice(firstCohortBatch).filter(batch => batch.receipt?.identity.operation === `${APP}.primary_cohort`);
      assert.equal(cohortBatches.length, 3, 'one canonical body receipt per original frozen member');
      const updatedIds: string[] = [];
      for (const batch of cohortBatches) {
        await assertBodyReceipt(batch, `${APP}.primary_cohort`);
        const business = batch.writes.filter(write => write.model === ENTRY || write.model === AUDIT);
        assert.equal(business.length, 1); const write = business[0]!;
        assert.equal(write.kind, 'update'); if (write.kind !== 'update') throw new Error('Original cohort did not update its admitted member');
        assert.equal(write.model, ENTRY); updatedIds.push(write.id);
        const originalRow = domainBefore.find(row => row.id === write.id); assert.ok(originalRow);
        assert.equal(write.expectedVersion, originalRow.version); assert.equal(write.row.version, Number(originalRow.version) + 1);
        assert.deepEqual(write.row.data, { seen: `accepted-${deliveryId}` });
        assert.deepEqual(await store.load(ENTRY, write.id), write.row);
        assert.deepEqual({ ...write.row, version: originalRow.version, data: originalRow.data,
          updated: originalRow.updated, updatedBy: originalRow.updatedBy }, originalRow);
        assert.equal(batch.history.length, 1); const history = batch.history[0]!;
        assert.equal(history.model, ENTRY); assert.equal(history.recordId, write.id); assert.equal(history.version, write.row.version);
        assert.equal(history.change, 'update'); assert.deepEqual(history.before, originalRow.data); assert.deepEqual(history.after, write.row.data);
        assert.deepEqual(await store.historyFor(ENTRY, write.id), [...historyBefore[memberIds.indexOf(write.id)]!, history]);
        assert.ok(batch.receipt!.outcome.status === 'committed');
        assert.deepEqual(batch.receipt!.outcome.recordVersions.filter(row => row.model === ENTRY || row.model === AUDIT),
          [{ model: ENTRY, id: write.id, version: write.row.version }]);
      }
      assert.deepEqual(updatedIds.sort(), memberIds);
      assert.deepEqual((await query(ENTRY)).map(row => [row.id, row.version, row.data]),
        [...domainBefore.map(row => [row.id, Number(row.version) + 1, { seen: `accepted-${deliveryId}` }]),
          ['late', domainWithLate.find(row => row.id === 'late')!.version, { seen: 'late' }]]);
      assert.deepEqual((await query(ENTRY)).find(row => row.id === 'late'), domainWithLate.find(row => row.id === 'late'));
      assert.deepEqual(await store.historyFor(ENTRY, asId('late')), []);
      assert.deepEqual(await query(AUDIT), auditsBeforeCohort);
      assertUnrelatedTables(beforeCohort, await all());
      const receipts = await dbA.prepare('SELECT app, owner, principal, operation, operation_id AS operationId FROM receipts ORDER BY operation_id').all<ReceiptIdentity>();
      assert.equal(receipts.results.length, 5, 'two ordinary and three cohort canonical invocation receipts');
      for (const identity of receipts.results) {
        assert.ok([`${APP}.primary_first`, `${APP}.primary_last`, `${APP}.primary_cohort`].includes(identity.operation));
        const saved = await store.readReceipt(identity); assert.ok(saved); assert.equal(saved.outcome.status, 'committed');
        assert.equal(saved.identity.app, APP); assert.equal(saved.identity.owner, scope.owner);
      }
      const replayFanout = async (body: typeof generated, source: string, members: string[]) => {
        const replayBefore = await all(), idsBefore = sequence, writesBefore = batches.length;
        let cursor: string | null = null; const replayed: string[] = [];
        for (let page = 0; ; page++) {
          assert.ok(page < 3);
          const turn = await runFanoutSchedulerTurn({ store: observed, fanoutId: body.fanoutId, cursor,
            bounds: { pageLimit: 2, maxDrives: 2 }, policy: { maxAttempts: 3, horizonMs: 60000 }, meta: { actor: body.trustedSource, nowMs: clock.nowMs() },
            maxClaimAgeMs: 60000, cohort: { model: body.cohort.model },
            freeze: { cutoff: { sourceOccurrence: source, handler: `${APP}.primary_cohort` }, cohort: body.cohort, owner: team.team_id,
              bounds: { ...body.bounds, maxAttempts: 3 } }, guard: { predicate: null, frozenInputs: null }, evaluateGuard: () => true,
            readSnapshot: (_child, row) => row, fenceFor: () => ({ owner: team.team_id,
              revalidateAuthority: async () => (await identities.findTeamById(team.team_id)) !== null }), body: body.body, producers,
            invoke: { registry: body.registry, memberships: identities, clock, identity: body.identity, app: APP,
              source: 'schedule', childOperation: `${APP}.primary_cohort`, refInput: body.refInput, inputs: body.inputs,
              kind: 'trusted', trustedSource: body.trustedSource, operationIdFor: nextId } });
          assert.equal(turn.status, 'turn'); if (turn.status !== 'turn') throw new Error('retained terminal turn absent');
          assert.ok(turn.driven.every(child => child.status === 'replayed')); replayed.push(...turn.driven.map(child => child.recordId));
          if (turn.done) break; assert.ok(turn.cursor); cursor = turn.cursor;
        }
        assert.deepEqual(replayed, members); assert.equal(sequence, idsBefore); assert.equal(batches.length, writesBefore);
        assert.deepEqual(await read().then(value => value.result), consumed); assert.deepEqual(await all(), replayBefore);
      };
      await replayFanout(generated, sourceOccurrence, memberIds);
      assert.deepEqual(await query(WORK_SCHEDULE_MODEL), []); assert.equal(sends.length, 1);
      const finalOutbox = await store.outboxGet(deliveryId); assert.ok(finalOutbox);
      assert.equal(finalOutbox.status, 'dispatched'); assert.deepEqual(finalOutbox.intent, original.intent);
      assert.deepEqual(finalOutbox.originalCommit, original.originalCommit);
      assert.deepEqual({ b: await snapshot(dbB), identity: await snapshot(identityDb) }, isolated);
      assert.ok((await query(WORK_HANDLER_OCCURRENCE_MODEL)).map(readHandlerOccurrenceRow).every(route => route.state === 'completed'));

      // The unchanged source guard runs before create/set. A genuine terminal
      // provider failure reaches that false branch; it proves body non-commit,
      // not a late failure after a staged domain write.
      const failedOrigin = nextId(), rejectedInput = { ...mailInput, subject: 'Rejected native completion' };
      const failedSend = await sendDelivery(failedOrigin, rejectedInput);
      const failedDeliveryId = String(object(failedSend.result)['deliveryId']);
      const failedOriginal = await store.outboxGet(failedDeliveryId); assert.ok(failedOriginal?.originalCommit);
      const failedDrive = await dispatcher.drive({ intentId: failedDeliveryId, actor: user.user_id, operation: 'component.completion.drive',
        nowMs: clock.nowMs, nextClaimId: () => `claim-${++sequence}`, maxClaimAgeMs: 60000,
        claimOperationId: nextId(), recordOperationId: nextId(), classifyFailure, evaluateGuard: () => true, readStateSnapshot: () => null,
        fence: { owner: team.team_id, attemptDispatch: attemptDispatch as FenceAttemptDispatchFn,
          revalidateAuthority: async () => (await identities.findMembership(team.team_id, user.user_id))?.is_owner === true } });
      assert.equal(failedDrive.status, 'recorded'); assert.equal(sends.length, 2);
      assert.deepEqual(sends[1], { ...rejectedInput, delivery_id: failedDeliveryId });
      const retainedFailedOutbox = await store.outboxGet(failedDeliveryId); assert.ok(retainedFailedOutbox);
      const failedTerminalRow = await store.load(asModel(RECEIPT_MODEL), asId(failedDeliveryId)); assert.ok(failedTerminalRow);
      const failedTerminal = readReceiptRow(failedTerminalRow); assert.equal(failedTerminal.receipt.status, 'failed');
      assert.equal(failedTerminal.receipt.result, null); assert.ok(failedTerminal.receipt.error);
      const failureIssue = await sourceRegistry.run(native.name, { deliveryId: failedDeliveryId },
        { actor: user.user_id, now: clock.nowMs(), operation: EVENT, operationId: nextId() }, { store: observed });
      assert.equal(object(failureIssue.result)['status'], 'staged');
      const failedSource = String(object(failureIssue.result)['sourceOccurrence']);
      assert.deepEqual(object(failureIssue.result)['payload'], { delivery_id: failedDeliveryId,
        status: 'failed', result: null, error: failedTerminal.receipt.error });
      const failedSourceRead = await sourceRegistry.read(native.name, { deliveryId: failedDeliveryId },
        { actor: user.user_id, now: clock.nowMs(), operation: EVENT, operationId: 'failed-completion-read' }, { store: observed });
      const failedSourceProof = object(failedSourceRead.result);
      assert.deepEqual(object(object(failedSourceProof['result'])['origin'])['intent'], failedOriginal.intent);
      assert.deepEqual(object(object(failedSourceProof['result'])['origin'])['originalCommit'], failedOriginal.originalCommit);
      assert.deepEqual((object(failedSourceProof['result'])['handlers'] as Record<string, unknown>[]).map(route => route['handler']),
        expectedCensus[0]!.handlers);
      const failedOrdinary = { ...ordinary, selector: { ...selector, sourceOccurrence: failedSource } };
      const beforeFailedBody = await all(), failedBatches = batches.length, failedRevision = await store.readRevision();
      const rejectedBody = object(await invokeRetainedHandlerOccurrenceCanonical(failedOrdinary));
      assert.equal(rejectedBody['status'], 'failed'); assert.equal(batches.length, failedBatches + 1);
      assert.equal(await store.readRevision(), Number(failedRevision) + 1);
      const failedBatch = batches.at(-1)!; await assertBodyReceipt(failedBatch, `${APP}.primary_first`);
      assert.deepEqual(failedBatch.writes.map(write => [write.model, write.kind]),
        [[WORK_HANDLER_OCCURRENCE_MODEL, 'update'], [WORK_OCCURRENCE_MODEL, 'insert']]);
      assert.deepEqual(failedBatch.history, []); assert.ok(failedBatch.receipt!.outcome.status === 'committed');
      assert.equal(object(failedBatch.receipt!.outcome.result)['status'], 'failed');
      assert.deepEqual(failedBatch.receipt!.outcome.recordVersions.filter(row => row.model === ENTRY || row.model === AUDIT), []);
      const failedRoute = (await query(WORK_HANDLER_OCCURRENCE_MODEL)).map(readHandlerOccurrenceRow)
        .find(route => route.sourceOccurrence === failedSource && route.handler === `${APP}.primary_first`); assert.ok(failedRoute);
      assert.equal(failedRoute.state, 'failed');
      const failedBodyRow = await store.load(WORK_OCCURRENCE_MODEL, asId(failedRoute.occurrenceId)); assert.ok(failedBodyRow);
      const failedBodyReceipt = readOccurrenceRow(failedBodyRow);
      assert.equal(failedBodyReceipt.status, 'failed'); assert.equal(failedBodyReceipt.code, 'require-false');
      const afterFailedBody = await all(); assertUnrelatedTables(beforeFailedBody, afterFailedBody);
      assert.deepEqual(afterFailedBody.a['history'], beforeFailedBody.a['history']);
      assert.deepEqual(afterFailedBody.a['sqlite_sequence'], beforeFailedBody.a['sqlite_sequence']);
      const businessRows = (rows: Record<string, unknown>[]) => rows.filter(row => row['model'] === ENTRY || row['model'] === AUDIT);
      assert.deepEqual(businessRows(afterFailedBody.a['records']!), businessRows(beforeFailedBody.a['records']!));
      const failedKeys = new Set(failedBatch.writes.map(write => `${write.model}\0${write.kind === 'remove' ? write.id : write.row.id}`));
      const untouchedFailure = (rows: Record<string, unknown>[]) => rows.filter(row => !failedKeys.has(`${row['model']}\0${row['id']}`));
      assert.deepEqual(untouchedFailure(afterFailedBody.a['records']!), untouchedFailure(beforeFailedBody.a['records']!));
      assert.equal(afterFailedBody.a['receipts']!.length, beforeFailedBody.a['receipts']!.length + 1);
      assert.equal(afterFailedBody.a['fence_log']!.length, beforeFailedBody.a['fence_log']!.length + 1);
      assert.deepEqual(afterFailedBody.a['receipts']!.filter(row => row['operation_id'] !== failedBatch.receipt!.identity.operationId),
        beforeFailedBody.a['receipts']);
      assert.deepEqual(afterFailedBody.a['fence_log']!.filter(row => row['revision'] !== failedBatch.receipt!.committedRevision),
        beforeFailedBody.a['fence_log']);
      assert.equal(object(await invokeRetainedHandlerOccurrenceCanonical(failedOrdinary))['status'], 'replayed');
      assert.equal(batches.length, failedBatches + 1); assert.deepEqual(await all(), afterFailedBody);
      const failedLast = { ...failedOrdinary, selector: { ...failedOrdinary.selector, handler: `${APP}.primary_last` } };
      const beforeFailedLast = batches.length;
      assert.equal(object(await invokeRetainedHandlerOccurrenceCanonical(failedLast))['status'], 'completed');
      assert.equal(batches.length, beforeFailedLast + 1); await assertBodyReceipt(batches.at(-1)!, `${APP}.primary_last`);
      assert.deepEqual(batches.at(-1)!.writes.filter(write => write.model === ENTRY || write.model === AUDIT), []);
      assert.deepEqual(batches.at(-1)!.history, []);
      const lastReplay = await all();
      assert.equal(object(await invokeRetainedHandlerOccurrenceCanonical(failedLast))['status'], 'replayed');
      assert.equal(batches.length, beforeFailedLast + 1); assert.deepEqual(await all(), lastReplay);
      const failedGenerated = await createCanonicalCommittedCohortBody({ artifact, asm, app: APP, handler: `${APP}.primary_cohort`,
        source: { occurrenceId: failedSource, event: EVENT, scope }, store: observed, identities, now: clock.nowMs });
      const failedMembers = [...memberIds, 'late'];
      const failedIntent = (await query(WORK_FANOUT_INTENT_MODEL)).map(readFanoutIntentRow)
        .find(intent => intent.sourceOccurrence === failedSource); assert.ok(failedIntent);
      assert.deepEqual(failedIntent.members, failedMembers); assert.equal(failedIntent.handler, `${APP}.primary_cohort`);
      const beforeFailedCohort = await all(), firstFailedCohortBatch = batches.length;
      for (let turn = 0; ; turn++) {
        assert.ok(turn < 16, 'the genuine failed delivery cohort settles its four original frozen members');
        await tick.tick();
        const progress = await readFanoutSchedulerProgress({ store, fanoutId: failedGenerated.fanoutId, pageLimit: 4, producers });
        if (progress.terminal) { assert.equal(progress.failed, 4); assert.equal(progress.completed, 0); break; }
      }
      const failedChildren = (await query(WORK_FANOUT_CHILD_MODEL)).map(readFanoutChildRow)
        .filter(child => child.parentOccurrence === failedSource);
      assert.deepEqual(failedChildren.map(child => child.recordId).sort(), failedMembers);
      assert.ok(failedChildren.every(child => child.handler === `${APP}.primary_cohort` && child.state === 'failed' &&
        child.causeKind === 'failed' && child.causeReason === 'business-rejection'));
      const failedCohortBatches = batches.slice(firstFailedCohortBatch).filter(batch => batch.receipt?.identity.operation === `${APP}.primary_cohort`);
      assert.equal(failedCohortBatches.length, 4, 'one genuine State rejection receipt for each failed body');
      for (const batch of failedCohortBatches) {
        await assertBodyReceipt(batch, `${APP}.primary_cohort`);
        assert.ok(batch.receipt!.outcome.status === 'rejected'); assert.equal(batch.receipt!.outcome.code, 'rule_failed');
        assert.deepEqual(batch.writes, []); assert.deepEqual(batch.history, []);
      }
      assert.deepEqual(failedCohortBatches.map(batch => batch.receipt!.inputHash).sort(),
        (await Promise.all(failedMembers.map(id => hashInputs({ ...failedGenerated.inputs,
          [failedGenerated.refInput]: { id } })))).sort(), 'rejections retain the exact source arguments and original admitted member slots');
      const afterFailedCohort = await all(); assertUnrelatedTables(beforeFailedCohort, afterFailedCohort);
      assert.deepEqual(businessRows(afterFailedCohort.a['records']!), businessRows(beforeFailedCohort.a['records']!));
      assert.deepEqual(afterFailedCohort.a['history'], beforeFailedCohort.a['history']);
      assert.deepEqual(afterFailedCohort.a['sqlite_sequence'], beforeFailedCohort.a['sqlite_sequence']);
      assert.equal(afterFailedCohort.a['receipts']!.length, beforeFailedCohort.a['receipts']!.length + 4);
      assert.deepEqual(failedIntent.members, (await query(WORK_FANOUT_INTENT_MODEL)).map(readFanoutIntentRow)
        .find(intent => intent.sourceOccurrence === failedSource)!.members);
      await replayFanout(failedGenerated, failedSource, failedMembers);
      assert.deepEqual(await store.outboxGet(deliveryId), finalOutbox);
      assert.deepEqual(await store.outboxGet(failedDeliveryId), retainedFailedOutbox);
      assert.deepEqual(await query(WORK_SCHEDULE_MODEL), []);
      assert.deepEqual({ b: await snapshot(dbB), identity: await snapshot(identityDb) }, isolated);
      assert.equal(JSON.stringify(artifact), artifactJson);
      assert.deepEqual(await Promise.all([artifactPath, sourcePath, catalogPath].map(path => readFile(path))), originals);
    } finally {
      if (listening) { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
      if (worker !== undefined) await worker.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
