/** Real native consumer composition derived from the owning committed-change
 * fixture, with explicitly authored CRUD operations. This is not acceptance of
 * that unchanged fixture as a full application, or original Volunteer source. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationEnvelope, Receipt, ReceiptIdentity, StoragePort, WorkScope } from '@canlang/contracts';
import { distribution } from '@canlang/values/distribution';
import { createD1OwnerRouter } from '@canlang/state/storage/owner-router';
import { ensureSchema } from '@canlang/state/storage/d1';
import { asId, asModel, asOperationId, FIXED_NOW, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { buildSessionCookie, createD1IdentityStore, deriveCsrfToken, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { catalogFromArtifactOperations, createSourceFormBindings, handleOperationRequest } from '@canlang/interfaces/http/operations';
import { createTestDeps } from '@canlang/interfaces/testing';
import { WORK_OCCURRENCE_MODEL, WORK_SCHEDULE_MODEL, readOccurrenceRow } from '@canlang/work/kernel/tables';
import { WORK_HANDLER_OCCURRENCE_MODEL, readHandlerOccurrenceRow } from '@canlang/work/kernel/handler-occurrence';
import { WORK_FANOUT_INTENT_MODEL, readFanoutIntentRow } from '@canlang/work/kernel/tables';
import { assembleModules, importVerifiedAssemblyModule } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker, createTeamOwnerStorageBoundary } from '@canlang/cloudflare/worker/assembly';
import { createCanonicalCommittedCohortBody, invokeRetainedHandlerOccurrenceCanonical,
  loadFanoutStateProducers, runFanoutSchedulerTurn, readFanoutSchedulerProgress, invokeCallable } from '@canlang/cloudflare/runtime/invoke';

import { createBoundCohortTick } from '../dist/runtime/cohort-tick.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const APP = 'CommittedJourney', LOCAL = asModel(`${APP}.Local`), ENTRY = asModel(`${APP}.Entry`);
type Tables = Record<string, readonly Record<string, unknown>[]>;
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function snapshot(db: D1Database): Promise<Tables> {
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{ name: string }>();
  assert.equal(tables.success, true);
  const result: Tables = {};
  for (const { name } of tables.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    result[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
function status(value: unknown): unknown { return object(value)['status']; }

test('authored native CRUD joins checked committed sources and retained ordinary/cohort bodies in real owner D1',
  { timeout: 120000 }, async () => {
    const fixture = join(root, 'compiler/tests/fixtures/committed_change.can');
    const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
    const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
    const original = await readFile(fixture, 'utf8');
    const needle = 'When\n scenario created on=Local.created';
    assert.equal(original.split(needle).length, 2, 'one exact owning fixture insertion point');
    // Operations are real source declarations, not injected descriptors or host business handlers.
    const authored = original.replace(needle,
      'When\n crud Local by=members fields=title delete=remove\n crud Entry by=members fields=label,count\n scenario change(record:Local,title:text) -> text by=members\n  do\n   set record {title}\n   return title\n scenario entry_changed on=Entry.updated\n  do\n   let identity=event.id\n   let revision=event.version\n scenario created on=Local.created');
    const producerHashes = await Promise.all([fixture, compiler, catalog].map(async path => digest(await readFile(path))));
    const dir = await mkdtemp(join(tmpdir(), 'can-committed-model-consumer-'));
    let worker: Miniflare | undefined, sequence = 0;
    const clock = { nowMs: () => FIXED_NOW };
    const nextId = () => asOperationId(uuidv7(FIXED_NOW, ++sequence));
    try {
      const input = join(dir, 'committed-consumer.can'); await writeFile(input, authored);
      const env = { ...process.env }; delete env.CAN_CATALOG;
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, input],
        { cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      assert.equal(artifact.artifact_version, 1); assert.ok(artifact.modules.length > 0);
      assert.ok(artifact.sources.some(source => resolve(source.path) === input && source.sha256 === digest(authored)));
      const census = [
        { source: `${APP}.Entry.updated`, model: ENTRY, change: 'update', handlers: [`${APP}.entry_changed`] },
        { source: `${APP}.Local.created`, model: LOCAL, change: 'create', handlers: [`${APP}.created`] },
        { source: `${APP}.Local.updated`, model: LOCAL, change: 'update', handlers: [`${APP}.updated_first`, `${APP}.updated_cohort`, `${APP}.updated_last`] },
        { source: `${APP}.Local.deleted`, model: LOCAL, change: 'delete', handlers: [`${APP}.deleted`] },
        { source: 'Stored.Record.updated', model: 'Stored.Record', change: 'update', handlers: [`${APP}.imported`] },
      ];
      assert.deepEqual([...artifact.committedChanges ?? []].sort((a,b)=>a.source.localeCompare(b.source)),
        census.sort((a,b)=>a.source.localeCompare(b.source)), 'complete owning census and handler declaration order survive the authored CRUD composition');
      for (const operation of ['Local.create', 'Local.update', 'Local.delete', 'Entry.create']) {
        assert.ok(artifact.operations?.some(def => def.name === `${APP}.${operation}`));
      }
      const asm = await assembleModules({ artifact, sourcePath: input }, { workDir: join(dir, 'modules'),
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      const handler = artifact.callables.find(callable => callable.id === `${APP}.updated_cohort`); assert.ok(handler);
      const namespace = object(await importVerifiedAssemblyModule(asm, handler.module, artifact));
      const definition = object(namespace['appDefinition']);
      assert.deepEqual(definition['committedChanges'], artifact.committedChanges);
      assert.equal(Object.hasOwn(object(definition['events']), `${APP}.Local.deleted`), false);
      for (const name of ['created', 'updated_first', 'updated_cohort', 'updated_last', 'deleted', 'imported', 'declared', 'entry_changed']) {
        assert.ok(artifact.callables.some(callable => callable.kind === 'handler' && callable.id === `${APP}.${name}`));
      }
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: { IDENTITY: 'committed-identity', A: 'committed-owner-a', B: 'committed-owner-b' }, d1Persist: join(dir, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const dbA = await worker.getD1Database('A') as unknown as D1Database, dbB = await worker.getD1Database('B') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(dbA); await ensureSchema(dbB);
      const identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' }), foreignTeam = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: 'committed-member@example.test', password_hash: 'unused', email_verified: true });
      await identities.createMembership({ user_id: user.user_id, team_id: team.team_id, is_owner: true, roles: [] });
      const token = randomBytes(32).toString('hex');
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        expires_at: new Date(FIXED_NOW + 3600000).toISOString(), last_team_id: team.team_id });
      const identity = await resolveIdentity(identities, { session_token: token }, { clock });
      const boundary = await createTeamOwnerStorageBoundary({ artifact, asm, app: APP, identities,
        router: createD1OwnerRouter({ resolveBinding: selected => selected.app === APP &&
          (selected.owner === team.team_id || selected.owner === foreignTeam.team_id)
          ? { ...selected, db: selected.owner === team.team_id ? dbA : dbB, initializeFresh: true } : null }) });
      const scope: WorkScope = { app: APP, owner: team.team_id, ownerPackage: APP };
      const foreignScope: WorkScope = { ...scope, owner: foreignTeam.team_id };
      const store = await boundary.forIdentity(identity), foreign = await boundary.forTrustedScope(foreignScope, FIXED_NOW);
      const batches: Parameters<StoragePort['commit']>[0][] = [];
      const observed: StoragePort = { ...store, commit: async batch => { batches.push(batch); return store.commit(batch); } };
      const invoker = buildInvoker(artifact, asm, observed, { appId: APP, memberships: identities, now: clock.nowMs });
      const all = async () => ({ a: await snapshot(dbA), b: await snapshot(dbB), identity: await snapshot(identityDb) });
      const initialForeign = await snapshot(dbB);
      const query = (model: string) => store.query({ model: asModel(model), authority: 'owner', archived: 'include', order: [{ field: 'id', direction: 'asc' }] });
      const mutate = async (operation: string, inputs: MutationEnvelope['inputs']) => {
        const envelope: MutationEnvelope = { operation: `${APP}.${operation}`, operation_id: nextId(), inputs };
        const beforeBatches = batches.length;
        const outcome = await invoker.invokeMutation(envelope, identity);
        assert.ok('result' in outcome, JSON.stringify(outcome)); assert.equal(outcome.result.status, 'committed');
        assert.equal(batches.length, beforeBatches + 1); const batch = batches.at(-1)!;
        assert.ok(batch.receipt); assert.equal(batch.receipt.outcome.status, 'committed');
        const receipt: Receipt = batch.receipt;
        const before = await all();
        const replay = await invoker.invokeMutation(envelope, identity);
        assert.ok('result' in replay, JSON.stringify(replay)); assert.equal(replay.result.status, 'replayed');
        assert.equal(batches.length, beforeBatches + 1);
        assert.deepEqual(replay.result.result, outcome.result.result); assert.deepEqual(replay.result.records, outcome.result.records);
        assert.deepEqual(await all(), before);
        return { envelope, batch, receipt, result: outcome.result };
      };
      const entryIds: string[] = [];
      for (const label of ['A', 'B', 'C']) {
        const created = await mutate('Entry.create', { label }); entryIds.push(created.envelope.operation_id);
      }
      const created = await mutate('Local.create', { title: 'first' });
      const local = await store.load(LOCAL, asId(created.envelope.operation_id)); assert.ok(local);
      const updated = await mutate('Local.update', { record: { id: local.id, version: String(local.version) }, title: 'second' });
      const current = await store.load(LOCAL, local.id); assert.ok(current); assert.equal(current.version, local.version + 1);
      let sources = await query(WORK_OCCURRENCE_MODEL); assert.equal(sources.length, 2);
      const sourceFor = (event: string) => {
        const row = sources.find(row => object(readOccurrenceRow(row).result)['event'] === event); assert.ok(row);
        const occurrence = readOccurrenceRow(row), result = object(occurrence.result), payload = object(result['payload']);
        assert.equal(result['kind'], 'committed-model-source'); assert.equal(payload['recordId'], local.id);
        assert.equal(payload['owner'], team.team_id); assert.equal(payload['occurrenceId'], occurrence.occurrenceId);
        return { row, occurrence, result, payload };
      };
      for (const [event, kind, commit, version] of [
        [`${APP}.Local.created`, 'created', created, local.version],
        [`${APP}.Local.updated`, 'updated', updated, current.version],
      ] as const) {
        const selected = sourceFor(event), change = object(selected.result['change']), context = object(selected.result['context']);
        assert.deepEqual(change, { model: LOCAL, recordId: local.id, version, kind }); assert.equal(selected.payload['version'], version);
        assert.equal(context['operation'], commit.envelope.operation); assert.equal(context['operationId'], commit.envelope.operation_id);
        assert.equal(selected.result['revision'], commit.batch.expectedRevision);
        assert.ok(commit.batch.writes.some(write => write.model === WORK_OCCURRENCE_MODEL && write.kind === 'insert' && write.row.id === selected.row.id));
        assert.equal(commit.receipt.committedRevision, Number(commit.batch.expectedRevision) + 1);
      }
      const updateSource = sourceFor(`${APP}.Local.updated`);
      const handlers = await query(WORK_HANDLER_OCCURRENCE_MODEL);
      assert.deepEqual(handlers.filter(row => readHandlerOccurrenceRow(row).sourceOccurrence === updateSource.occurrence.occurrenceId)
        .map(row => readHandlerOccurrenceRow(row).handler).sort(), [`${APP}.updated_first`, `${APP}.updated_last`]);
      const intents = await query(WORK_FANOUT_INTENT_MODEL); assert.equal(intents.length, 1);
      const intent = readFanoutIntentRow(intents[0]!); assert.deepEqual(intent.members, [...entryIds].sort());
      assert.deepEqual((updateSource.result['handlers'] as unknown[]).map(item => object(item)['handler']),
        [`${APP}.updated_first`, `${APP}.updated_cohort`, `${APP}.updated_last`]);
      const late = await mutate('Entry.create', { label: 'late' });
      assert.deepEqual(readFanoutIntentRow((await store.load(WORK_FANOUT_INTENT_MODEL, intents[0]!.id))!).members, [...entryIds].sort());
      assert.deepEqual(await query(WORK_SCHEDULE_MODEL), [], 'committed sources require no invented schedule');

      const checkRetainedHandler = async (row: Awaited<ReturnType<typeof query>>[number]) => {
        const retained = readHandlerOccurrenceRow(row);
        const selector = { sourceOccurrence: retained.sourceOccurrence, handler: retained.handler, event: retained.event, scope };
        let deletedLoads = 0;
        const live: StoragePort = { ...store, load: async (model, id) => {
          if (retained.handler === `${APP}.deleted` && model === LOCAL && id === local.id) deletedLoads++;
          return store.load(model, id);
        } };
        const options = { artifact, asm, app: APP, selector, store: live, identities, now: clock.nowMs };
        assert.equal(status(await invokeRetainedHandlerOccurrenceCanonical(options)), 'completed');
        assert.equal(deletedLoads, 0, 'deleted id/version inputs need no missing domain-row load');
        const before = await all();
        assert.equal(status(await invokeRetainedHandlerOccurrenceCanonical(options)), 'replayed'); assert.deepEqual(await all(), before);
        assert.equal(status(await invokeRetainedHandlerOccurrenceCanonical({ ...options,
          selector: { ...selector, scope: foreignScope }, store: foreign.store })), 'refused');
        assert.deepEqual(await all(), before);
      };
      for (const row of handlers) await checkRetainedHandler(row);
      const producers = await loadFanoutStateProducers();
      const generated = await createCanonicalCommittedCohortBody({ artifact, asm, app: APP,
        handler: `${APP}.updated_cohort`, source: { occurrenceId: updateSource.occurrence.occurrenceId,
          event: `${APP}.Local.updated`, scope }, store, identities, now: clock.nowMs });
      assert.equal(generated.identity.actor, null); assert.equal(generated.identity.team?.team_id, team.team_id);
      const runTurn = (selectedCursor: string | null) => runFanoutSchedulerTurn({ store, fanoutId: generated.fanoutId, cursor: selectedCursor,
          bounds: { pageLimit: 2, maxDrives: 2 }, policy: { maxAttempts: 3, horizonMs: 60000 },
          meta: { actor: generated.trustedSource, nowMs: FIXED_NOW }, maxClaimAgeMs: 60000,
          cohort: { model: generated.cohort.model },
          freeze: { cutoff: { sourceOccurrence: updateSource.occurrence.occurrenceId, handler: `${APP}.updated_cohort` },
            cohort: generated.cohort, owner: team.team_id, bounds: { ...generated.bounds, maxAttempts: 3 } },
          guard: { predicate: null, frozenInputs: null }, evaluateGuard: () => true, readSnapshot: (_child, row) => row,
          fenceFor: () => ({ owner: team.team_id, revalidateAuthority: async () => (await identities.findTeamById(team.team_id)) !== null }),
          body: generated.body, producers, invoke: { registry: generated.registry, memberships: identities, clock,
            identity: generated.identity, app: APP, source: 'schedule', childOperation: `${APP}.updated_cohort`,
            refInput: generated.refInput, inputs: generated.inputs, kind: 'trusted', trustedSource: generated.trustedSource, operationIdFor: nextId },
        });
      const tick = await createBoundCohortTick({ artifact, asm, identities, ownerStorage: boundary, scope, now: clock.nowMs });
      for (let turn = 0; ; turn++) {
        assert.ok(turn < 12, 'actual bounded tick settles the schedule-free frozen cohort');
        const outputs = await tick.tick(); assert.ok(Array.isArray(outputs));
        const rows = await Promise.all(entryIds.map(id => store.load(ENTRY, asId(id))));
        const progress = await readFanoutSchedulerProgress({ store, fanoutId: generated.fanoutId, pageLimit: 4, producers });
        const pending = (await query(WORK_HANDLER_OCCURRENCE_MODEL)).map(readHandlerOccurrenceRow).filter(route => route.state === 'pending');
        if (rows.every(row => row?.version === 2) && progress.terminal && pending.length === 0) {
          assert.equal(progress.completed, entryIds.length); assert.equal(progress.failed, 0); break;
        }
      }
      // Each real cohort child updates a different Entry and emits its own source
      // in that child's business transaction. A root-wide source-ID memo must not
      // substitute the first child's source identity for later children.
      const childSources = (await query(WORK_OCCURRENCE_MODEL)).filter(row => {
        const result = readOccurrenceRow(row).result;
        return result !== null && typeof result === 'object' && !Array.isArray(result) &&
          object(result)['kind'] === 'committed-model-source' && object(result)['event'] === `${APP}.Entry.updated`;
      });
      assert.equal(childSources.length, entryIds.length);
      assert.equal(new Set(childSources.map(row => readOccurrenceRow(row).occurrenceId)).size, entryIds.length);
      const childOperationIds = new Set<string>();
      for (const row of childSources) {
        const source = object(readOccurrenceRow(row).result), change = object(source['change']);
        const context = object(source['context']), payload = object(source['payload']);
        assert.equal(change['model'], ENTRY); assert.equal(change['kind'], 'updated'); assert.equal(change['version'], 2);
        assert.ok(entryIds.includes(String(change['recordId'])));
        assert.equal(payload['recordId'], change['recordId']); assert.equal(payload['owner'], team.team_id);
        assert.equal(context['operation'], `${APP}.updated_cohort`);
        assert.equal(typeof context['operationId'], 'string'); childOperationIds.add(String(context['operationId']));
        const savedIdentity = await dbA.prepare('SELECT app, owner, principal, operation, operation_id AS operationId FROM receipts WHERE operation_id = ?')
          .bind(String(context['operationId'])).all<ReceiptIdentity>();
        assert.equal(savedIdentity.results.length, 1);
        const receipt = await store.readReceipt(savedIdentity.results[0]!); assert.ok(receipt);
        assert.equal(receipt.outcome.status, 'committed');
        assert.equal(receipt.committedRevision, Number(source['revision']) + 1);
        const history = await store.historyFor(ENTRY, asId(String(change['recordId'])));
        assert.equal(history.length, 2); assert.equal(history.at(-1)!.operationId, receipt.identity.operationId);
        assert.equal(history.at(-1)!.version, 2);
      }
      assert.equal(childOperationIds.size, entryIds.length);
      for (const id of entryIds) {
        const row = await store.load(ENTRY, asId(id)); assert.ok(row);
        assert.deepEqual(row.data, { label: local.id, count: String(current.version) }); assert.equal(row.version, 2);
      }
      const lateRow = await store.load(ENTRY, asId(late.envelope.operation_id)); assert.ok(lateRow);
      assert.deepEqual(lateRow.data, { label: 'late', count: '0' }); assert.equal(lateRow.version, 1);
      assert.deepEqual(readFanoutIntentRow((await store.load(WORK_FANOUT_INTENT_MODEL, intents[0]!.id))!).members, [...entryIds].sort());
      assert.deepEqual(await snapshot(dbB), initialForeign);
      const beforeCohortReplay = await all(), beforeIds = sequence;
      let replayCursor: string | null = null;
      const replayedMembers: string[] = [];
      for (let page = 0; ; page++) {
        assert.ok(page < 3, 'bounded replay visits the complete retained membership');
        const terminal = await runTurn(replayCursor);
        assert.equal(terminal.status, 'turn');
        if (terminal.status !== 'turn') throw new Error('terminal cohort was not retained');
        assert.ok(terminal.driven.every(child => child.status === 'replayed'));
        replayedMembers.push(...terminal.driven.map(child => child.recordId));
        assert.equal(sequence, beforeIds); assert.deepEqual(await all(), beforeCohortReplay);
        if (terminal.done) break;
        assert.ok(terminal.cursor); replayCursor = terminal.cursor;
      }
      assert.deepEqual(replayedMembers, [...entryIds].sort());
      assert.equal(sequence, beforeIds, 'retained terminal cohort allocates no child invocation identity');
      assert.deepEqual(await all(), beforeCohortReplay);
      // The checked root scenario uses the same owner finalizer as CRUD. Its
      // source and saved result must be part of the one actual root transaction.
      const scenarioRecord = await mutate('Local.create', { title: 'scenario-before' });
      const scenarioRow = await store.load(LOCAL, asId(scenarioRecord.envelope.operation_id)); assert.ok(scenarioRow);
      assert.ok(artifact.operations?.find(def => def.name === `${APP}.change`)?.result?.disclosure, 'real compiler checked root disclosure');
      const beforeScenarioHistory = await store.historyFor(LOCAL, scenarioRow.id);
      const changed = await mutate('change', { record: { id: scenarioRow.id, version: String(scenarioRow.version) }, title: 'scenario-after' });
      assert.equal(changed.result.result, 'scenario-after');
      const changedRow = await store.load(LOCAL, scenarioRow.id); assert.ok(changedRow);
      assert.equal(changedRow.version, scenarioRow.version + 1); assert.equal(changedRow.data['title'], 'scenario-after');
      const changedSources = changed.batch.writes.filter(write => write.model === WORK_OCCURRENCE_MODEL && write.kind === 'insert');
      assert.equal(changedSources.length, 1);
      const sourceWrite = changedSources[0]!; assert.equal(sourceWrite.kind, 'insert');
      if (sourceWrite.kind !== 'insert') throw new Error('source must be a real insert');
      const changedSource = object(readOccurrenceRow(sourceWrite.row).result);
      assert.equal(object(changedSource['context'])['operationId'], changed.envelope.operation_id);
      assert.deepEqual(changedSource['change'], { model: LOCAL, recordId: scenarioRow.id, version: changedRow.version, kind: 'updated' });
      assert.equal(changed.receipt.committedRevision, Number(changed.batch.expectedRevision) + 1);
      assert.ok(changed.receipt.outcome.status === 'committed');
      const scenarioHistory = await store.historyFor(LOCAL, scenarioRow.id);
      assert.equal(scenarioHistory.length, beforeScenarioHistory.length + 1);
      assert.equal(scenarioHistory.at(-1)!.operationId, changed.envelope.operation_id);
      assert.equal(scenarioHistory.at(-1)!.version, changedRow.version);
      assert.deepEqual(scenarioHistory.at(-1)!.after, changedRow.data);

      // Separate authored legacy compilation: a nominal result is deliberately
      // unclaimed, rather than an injected receipt disclosure plan.
      const legacyInput = join(dir, 'committed-model-return.can');
      const legacySource = authored.replace(' scenario change(record:Local,title:text) -> text by=members',
        ' scenario change(record:Local,title:text) -> Local by=members').replace('   return title\n', '   return record\n');
      await writeFile(legacyInput, legacySource);
      const legacyOutput = await promisify(execFile)(compiler, ['compile', '--format=json', '--catalog', catalog, legacyInput],
        { cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const legacyArtifact = JSON.parse(legacyOutput.stdout) as CompileArtifact;
      assert.equal(legacyArtifact.artifact_version, 1);
      assert.ok(legacyArtifact.sources.some(source => resolve(source.path) === legacyInput && source.sha256 === digest(legacySource)));
      assert.equal(legacyArtifact.operations?.find(def => def.name === `${APP}.change`)?.result?.disclosure, undefined);
      const legacyAsm = await assembleModules({ artifact: legacyArtifact, sourcePath: legacyInput }, {
        workDir: join(dir, 'legacy-modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      const legacyInvoker = buildInvoker(legacyArtifact, legacyAsm, observed, { appId: APP, memberships: identities, now: clock.nowMs });
      const legacyEnvelope: MutationEnvelope = { operation: `${APP}.change`, operation_id: nextId(),
        inputs: { record: { id: changedRow.id, version: String(changedRow.version) }, title: 'legacy-after' } };
      const beforeLegacyBatches = batches.length;
      const legacyResult = await legacyInvoker.invokeMutation(legacyEnvelope, identity);
      assert.ok('result' in legacyResult, JSON.stringify(legacyResult)); assert.equal(legacyResult.result.status, 'committed');
      const legacyRow = await store.load(LOCAL, changedRow.id); assert.ok(legacyRow);
      assert.equal(legacyRow.version, changedRow.version + 1); assert.equal(legacyRow.data['title'], 'legacy-after');
      assert.deepEqual(legacyResult.result.result, { id: legacyRow.id, version: String(legacyRow.version) });
      assert.equal(batches.length, beforeLegacyBatches + 1);
      assert.equal(batches.at(-1)!.writes.filter(write => write.model === WORK_OCCURRENCE_MODEL && write.kind === 'insert').length, 1);

      // Committed-only source authority also refuses an unissued copied assembly
      // before evaluating any substituted initializer or requesting a context.
      const marker = join(dir, 'unexpected-initializer'), substituted = join(dir, 'substituted.mjs');
      await writeFile(substituted, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');export function canApp(){return {}}`);
      const url = pathToFileURL(substituted).href;
      const copied = { ...legacyAsm, entryUrl: url,
        moduleUrls: Object.fromEntries(Object.keys(legacyAsm.moduleUrls).map(path => [path, url])) };
      const noContext = new Proxy({} as Parameters<typeof invokeCallable>[3], {
        get() { throw new Error('unissued assembly requested a handler context'); } });
      const beforeCopied = await all();
      await assert.rejects(() => invokeCallable(copied, legacyArtifact, `${APP}.change`, noContext), /assembler-owned|original verified assembly/);
      await assert.rejects(() => readFile(marker), { code: 'ENOENT' }); assert.deepEqual(await all(), beforeCopied);
      const beforeMismatch = await all();
      const mismatch = structuredClone(artifact);
      mismatch.committedChanges!.find(change=>change.source===`${APP}.Local.updated`)!.handlers.reverse();
      const refused = await buildInvoker(mismatch, asm, store, { appId: APP, memberships: identities, now: clock.nowMs })
        .invokeMutation({ operation: `${APP}.Local.create`, operation_id: nextId(), inputs: { title: 'must not exist' } }, identity);
      assert.ok('error' in refused, JSON.stringify(refused)); assert.deepEqual(await all(), beforeMismatch);
      // Keep remove's owning projection/replay gate last: it must still pass,
      // but cannot prevent the independent scenario/cohort joins from executing.
      assert.deepEqual(await store.load(LOCAL, local.id), current, 'the original delete target was not changed by later scenarios');
      const removed = await mutate('Local.delete', { record: { id: current.id, version: String(current.version) } });
      assert.equal(await store.load(LOCAL, local.id), null);
      sources = (await query(WORK_OCCURRENCE_MODEL)).filter(row => {
        const result = readOccurrenceRow(row).result;
        return result !== null && typeof result === 'object' && !Array.isArray(result) &&
          object(result)['kind'] === 'committed-model-source' && object(object(result)['change'])['recordId'] === local.id;
      });
      assert.equal(sources.length, 3, 'original Local has exactly create/update/delete sources');
      const deletedSource = sourceFor(`${APP}.Local.deleted`);
      const deletedChange = object(deletedSource.result['change']), deletedContext = object(deletedSource.result['context']);
      assert.deepEqual(deletedChange, { model: LOCAL, recordId: local.id, version: current.version + 1, kind: 'deleted' });
      assert.equal(deletedSource.payload['version'], current.version + 1);
      assert.equal(deletedContext['operation'], removed.envelope.operation); assert.equal(deletedContext['operationId'], removed.envelope.operation_id);
      assert.equal(deletedSource.result['revision'], removed.batch.expectedRevision);
      assert.ok(removed.batch.writes.some(write => write.model === WORK_OCCURRENCE_MODEL && write.kind === 'insert' && write.row.id === deletedSource.row.id));
      assert.equal(removed.receipt.committedRevision, Number(removed.batch.expectedRevision) + 1);
      const deletedHandlers = (await query(WORK_HANDLER_OCCURRENCE_MODEL)).filter(row =>
        readHandlerOccurrenceRow(row).sourceOccurrence === deletedSource.occurrence.occurrenceId);
      assert.equal(deletedHandlers.length, 1); assert.equal(readHandlerOccurrenceRow(deletedHandlers[0]!).handler, `${APP}.deleted`);
      await checkRetainedHandler(deletedHandlers[0]!);

      // The real checked scenario's expired signed carrier can observe only its
      // original receipt. Its protected ref retains the pre-mutation version.
      const http = await createTestDeps({});
      const formCatalog = catalogFromArtifactOperations(artifact);
      const derived = formCatalog.derivedFor?.(changed.envelope.operation); assert.ok(derived);
      const formBindings = await createSourceFormBindings(randomBytes(32), producerHashes.join(':'));
      const bindingContext = { appId: APP, sessionToken: token, identity, derived,
        operationId: changed.envelope.operation_id, nowMs: FIXED_NOW };
      const bound = { record: { id: scenarioRow.id, version: String(scenarioRow.version) } };
      const proof = await formBindings.seal(bindingContext, bound, ['title']);
      const expiredClock = { nowMs: () => FIXED_NOW + 16 * 60 * 1000 };
      const canonicalRecovery = buildInvoker(artifact, asm, observed,
        { appId: APP, memberships: identities, now: expiredClock.nowMs });
      let ordinaryCalls = 0, retainedCalls = 0;
      const httpInvoker = { ...canonicalRecovery,
        async invokeMutation(...args: Parameters<typeof canonicalRecovery.invokeMutation>) {
          ordinaryCalls++; return canonicalRecovery.invokeMutation(...args);
        },
        async invokeRetainedMutation(...args: Parameters<typeof canonicalRecovery.invokeRetainedMutation>) {
          retainedCalls++; return canonicalRecovery.invokeRetainedMutation(...args);
        },
      };
      const deps = { ...http.deps, app: { ...http.deps.app, appId: APP }, catalog: formCatalog,
        identity: { ...http.deps.identity, store: identities }, formBindings, invoker: httpInvoker, clock: expiredClock };
      const csrf = await deriveCsrfToken(token), cookie = buildSessionCookie(token, { maxAgeSeconds: 3600, secure: false });
      const submitSigned = (native: boolean, operationId = changed.envelope.operation_id,
        signed = proof.token, title = 'scenario-after') => {
        const body = { operation: changed.envelope.operation, operation_id: operationId,
          form_binding: signed, inputs: { title } };
        return handleOperationRequest(deps, new Request('https://test.invalid/operations', { method: 'POST',
          headers: { cookie, 'x-csrf-token': csrf,
            'content-type': native ? 'application/x-www-form-urlencoded' : 'application/json' },
          body: native ? new URLSearchParams({ operation: body.operation, operation_id: operationId,
            form_binding: signed, 'inputs[title]': title }).toString() : JSON.stringify(body),
        }), changed.envelope.operation);
      };
      const beforeRecovery = await all(), beforeRecoveryBatches = batches.length;
      for (const native of [false, true]) {
        const response = await submitSigned(native); assert.equal(response.status, 200, await response.clone().text());
        const result = await response.json() as typeof changed.result;
        assert.equal(result.status, 'replayed'); assert.equal(result.operation_id, changed.envelope.operation_id);
        assert.deepEqual(result.result, changed.result.result); assert.deepEqual(result.records, changed.result.records);
        assert.deepEqual(await all(), beforeRecovery); assert.equal(batches.length, beforeRecoveryBatches);
      }
      assert.equal((await submitSigned(false, changed.envelope.operation_id, proof.token, 'changed-retry')).status, 409);
      const unseen = asOperationId(uuidv7(FIXED_NOW, sequence + 100000));
      const unseenProof = await formBindings.seal({ ...bindingContext, operationId: unseen }, bound, ['title']);
      assert.equal((await submitSigned(true, unseen, unseenProof.token)).status, 404);
      assert.equal((await submitSigned(false, changed.envelope.operation_id, `${proof.token}x`)).status, 403);
      assert.equal(ordinaryCalls, 0); assert.equal(retainedCalls, 4);
      assert.deepEqual(await all(), beforeRecovery); assert.equal(batches.length, beforeRecoveryBatches);
      const membership = await identities.findMembership(team.team_id, user.user_id); assert.ok(membership);
      await identities.removeMembership(membership.membership_id);
      const afterRevocation = await all();
      assert.equal((await submitSigned(true)).status, 403);
      assert.equal(ordinaryCalls, 0); assert.equal(batches.length, beforeRecoveryBatches);
      assert.deepEqual(await all(), afterRevocation);
      assert.deepEqual(await Promise.all([fixture, compiler, catalog].map(async path => digest(await readFile(path)))), producerHashes);
    } finally { await worker?.dispose(); await rm(dir, { recursive: true, force: true }); }
  });
