import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, StoragePort } from '@canlang/contracts';
import type { SystemCommandContext } from '@canlang/state';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { createD1IdentityStore, ensureIdentitySchema } from '@canlang/identity';
import { WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS } from '@canlang/work/kernel/commands';
import { stageCanonicalSend } from '@canlang/work/kernel/dispatch-staging';
import { WORK_HANDLER_OCCURRENCE_MODEL, readHandlerOccurrenceRow } from '@canlang/work/kernel/handler-occurrence';
import { WORK_OCCURRENCE_MODEL, readOccurrenceRow } from '@canlang/work/kernel/tables';
import { attemptDispatch } from '@canlang/work/dispatch';
import { classifyFailure } from '@canlang/work/receipt';
import { asId, asModel, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { assembleModules, importVerifiedAssemblyModule } from './modules.js';
import { createResourceAdapter, createResourceDispatcher, resolveResourceSend } from './resource-dispatch.js';
import { assembleDispatchCommands } from '../worker/assembly.js';
import { createWorkerDispatchJoinPort, loadDispatchSystemProducers, withDispatchJoinPort, nativeHandlersUseOwnerMutationScope, type FenceAttemptDispatchFn } from './invoke.js';
import { createQueueRuntime, queueSourceOccurrenceId } from './queue-runtime.js';

it('retains every original queue route before real enqueue, recovers broker loss after restart and replays canonical handlers once', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'can-queue-runtime-'));
  let mf: Miniflare | undefined;
  try {
    const source = join(root, 'QueueJourney.can');
    writeFileSync(source, `app QueueJourney
context
 queue Jobs type=text
Given
 Processed {label:text}
 policy Processed read=members
When
 scenario consume on=Jobs
  do
   require actor==null
   require operation.source=="ingress"
   create Processed {label=event} as first
 scenario checked on=Jobs
  do
   require event!="reject"
   create Processed {label="checked"} as second
Then
`);
    const compiler = process.env.CAN_BINDING_COMPILER ?? resolve('compiler/target/debug/can');
    const catalog = process.env.CAN_BINDING_CATALOG ?? resolve('packages/cloudflare/dist/native-catalog.json');
    const artifact = JSON.parse(execFileSync(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: join(root, 'modules'),
      stdlibUrl: pathToFileURL(createRequire(import.meta.url).resolve('@canlang/cloudflare/runtime/stdlib')).href, uiUrl: pathToFileURL(createRequire(import.meta.url).resolve('@canlang/ui')).href });
    const imported = await importVerifiedAssemblyModule(asm, artifact.modules[0]!.path, artifact);
    assert.equal(typeof imported, 'object');
    assert.notEqual(imported, null);
    const definition = (imported as Record<string, unknown>).appDefinition;
    assert.equal(await nativeHandlersUseOwnerMutationScope(asm, artifact), true);
    const now = Date.now();
    let sequence = 0;
    const operationId = () => asOperationId(uuidv7(now, ++sequence));
    const open = async () => {
      mf = new Miniflare({ compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("private")}}',
        d1Databases: { STATE: 'queue-state', IDENTITY: 'queue-identity' }, queueProducers: { JOBS: 'queue-jobs' }, d1Persist: join(root, 'd1') });
      const stateDb = await mf.getD1Database('STATE') as unknown as D1Database;
      const identityDb = await mf.getD1Database('IDENTITY') as unknown as D1Database;
      await ensureSchema(stateDb); await ensureIdentitySchema(identityDb);
      return { store: createD1Storage(stateDb), identities: createD1IdentityStore(identityDb, { clock: { nowMs: () => Date.now() } }) };
    };
    let state = await open();
    const team = await state.identities.createTeam({ timezone: 'UTC' });
    const scope = { app: 'QueueJourney', owner: team.team_id, ownerPackage: 'QueueJourney' };
    let intake = createQueueRuntime({ artifact, asm, app: scope.app, scope, store: state.store, identities: state.identities, now: () => Date.now() });
    const producers = await loadDispatchSystemProducers();
    const registry = producers.createSystemRegistry([...assembleDispatchCommands({ l3Commands: [], workCommands: WORK_SYSTEM_COMMANDS, stageCommands: WORK_DISPATCH_STAGE_COMMANDS }), {
      name: 'queue.test-stage', async stage(args: Record<string, unknown>, ctx: SystemCommandContext) {
        const request = resolveResourceSend(definition, 'QueueJourney.Jobs.publish', { value: args.value }, 'QueueJourney.Jobs')!;
        const staged = await stageCanonicalSend({ operationId: args.operationId as string, source: 'QueueJourney.Jobs.publish', occurrenceIndex: 0,
          originOccurrence: null, request: request as unknown as Record<string, unknown> }, ctx);
        return { ...staged.effects, result: staged.delivery.id };
      },
    }]);
    const stage = async (value: string) => {
      const id = operationId();
      return (await registry.run('queue.test-stage', { value, operationId: id }, { actor: 'queue-test', now, operation: 'QueueJourney.publish', operationId: id }, { store: withDispatchJoinPort(state.store, await createWorkerDispatchJoinPort(state.store)) })).result as string;
    };
    const seen: string[] = [];
    const adapter = createResourceAdapter({ appDefinition: definition, transports: new Map([['QueueJourney.Jobs', {
      kind: 'queue' as const, deliver: async event => intake.deliver(event, async body => {
        const sourceRow = await state.store.load(WORK_OCCURRENCE_MODEL, asId(queueSourceOccurrenceId(body.eventId)));
        assert.partialDeepStrictEqual(readOccurrenceRow(sourceRow!).result, { kind: 'queue-source', event: 'QueueJourney.Jobs' });
        assert.equal((await state.store.query({ model: WORK_HANDLER_OCCURRENCE_MODEL, authority: 'owner' })).filter(row => readHandlerOccurrenceRow(row).sourceOccurrence === queueSourceOccurrenceId(body.eventId)).length, 2);
        seen.push(body.eventId); await (await mf!.getQueueProducer('JOBS')).send(body);
      }), reconcile: eventId => intake.reconcile(eventId),
    }]]) });
    let dispatcher = await createResourceDispatcher({ store: state.store, adapter });
    const drive = async (intentId: string) => dispatcher.drive({ intentId, actor: 'queue-test', operation: 'QueueJourney.drive',
      nowMs: () => Date.now(), nextClaimId: () => `queue-claim-${++sequence}`, maxClaimAgeMs: 100, claimOperationId: operationId(), recordOperationId: operationId(), classifyFailure,
      evaluateGuard: () => true, readStateSnapshot: () => null,
      fence: { owner: team.team_id, attemptDispatch: attemptDispatch as FenceAttemptDispatchFn, revalidateAuthority: async () => await state.identities.findTeamById(team.team_id) !== null } });
    const id = await stage('actual');
    const raw = (await state.store.outboxGet(id))!.intent;
    await assert.rejects(intake.accept({ eventId: id, source: raw.target, arguments: { value: 'actual' } }), /claimed Work/);
    assert.equal(await intake.reconcile(id), null);
    assert.partialDeepStrictEqual(await drive(id), { state: 'delivered' });
    assert.deepEqual(seen, [id]);
    assert.deepEqual(await state.store.query({ model: asModel('QueueJourney.Processed'), authority: 'owner' }), []);
    assert.deepEqual(await intake.reconcile(id), { kind: 'delivered', result: { eventId: id } });
    // The broker has no consumer here and loses its volatile message. Only D1 intake survives.
    await mf!.dispose(); mf = undefined;
    state = await open();
    dispatcher = await createResourceDispatcher({ store: state.store, adapter });
    const allocations: Array<{ operation: string; operationId: string; model: string; index: number; id: string }> = [];
    const createRecordAllocator = async (operation: string, operationId: string) => (model: string, index: number) => {
      const id = `${operationId}#owned:${index}`; allocations.push({ operation, operationId, model, index, id }); return id;
    };
    intake = createQueueRuntime({ artifact, asm, app: scope.app, scope, store: state.store, identities: state.identities, now: () => Date.now(), createRecordAllocator });
    let refuseCommit = true;
    const flaky: StoragePort = { ...state.store, commit: async batch => {
      if (refuseCommit && batch.writes.some(write => write.model === 'QueueJourney.Processed')) { refuseCommit = false; throw new Error('transient owner write outage'); }
      return state.store.commit(batch);
    } };
    const retry = createQueueRuntime({ artifact, asm, app: scope.app, scope, store: flaky, identities: state.identities, now: () => Date.now() });
    await assert.rejects(retry.consume(id));
    assert.deepEqual(await state.store.query({ model: asModel('QueueJourney.Processed'), authority: 'owner' }), []);
    assert.deepEqual((await state.store.query({ model: WORK_HANDLER_OCCURRENCE_MODEL, authority: 'owner' })).map(row => readHandlerOccurrenceRow(row).state), ['pending', 'pending']);
    assert.partialDeepStrictEqual(await intake.recover({ limit: 1 }), { visited: 1, completed: 1 });
    assert.partialDeepStrictEqual(await intake.consume(id), { status: 'completed' });
    const after = await state.store.readRevision();
    assert.partialDeepStrictEqual(await intake.consume(id), { status: 'completed' });
    assert.equal(await state.store.readRevision(), after);
    const processed = await state.store.query({ model: asModel('QueueJourney.Processed'), authority: 'owner' });
    assert.deepEqual(processed.map(row => row.data.label).sort(), ['actual', 'checked']);
    assert.deepEqual(processed.map(row => row.id).sort(), allocations.map(value => value.id).sort());
    assert.deepEqual(allocations.map(value => value.operation).sort(), ['QueueJourney.checked', 'QueueJourney.consume']);
    assert.equal(allocations.every(value => value.model === 'QueueJourney.Processed' && value.index === 0), true);
    assert.deepEqual((await state.store.query({ model: WORK_HANDLER_OCCURRENCE_MODEL, authority: 'owner' })).map(row => readHandlerOccurrenceRow(row).state), ['completed', 'completed']);
    const foreign = createQueueRuntime({ artifact, asm, app: scope.app, scope: { ...scope, owner: 'foreign-team' }, store: state.store, identities: state.identities, now: () => Date.now() });
    await assert.rejects(foreign.consume(id));
    const tampered: StoragePort = { ...state.store, outboxGetBounded: async input => {
      const saved = await state.store.outboxGetBounded!(input); if (!saved) return null;
      return { ...saved, intent: { ...saved.intent, arguments: { binding: 'QueueJourney.Jobs', from: 'QueueJourney.Jobs', arguments: { value: 'forged' } } } };
    } };
    await assert.rejects(createQueueRuntime({ artifact, asm, app: scope.app, scope, store: tampered, identities: state.identities, now: () => Date.now() }).consume(id), /original outbox/);
    assert.equal(await state.store.readRevision(), after);
    const refusedId = await stage('reject');
    assert.partialDeepStrictEqual(await drive(refusedId), { state: 'delivered' });
    const rejected = await intake.consume(refusedId);
    assert.equal(rejected.status, 'completed');
    assert.equal(rejected.handlers.length, 2);
    const failures = (await state.store.query({ model: WORK_HANDLER_OCCURRENCE_MODEL, authority: 'owner' }))
      .map(readHandlerOccurrenceRow).filter(row => row.sourceOccurrence === queueSourceOccurrenceId(refusedId));
    assert.deepEqual(failures.map(row => row.state).sort(), ['completed', 'failed']);
    const refusedRevision = await state.store.readRevision();
    await intake.consume(refusedId);
    assert.equal(await state.store.readRevision(), refusedRevision);
    assert.deepEqual((await state.store.query({ model: asModel('QueueJourney.Processed'), authority: 'owner' })).map(row => row.data.label).sort(), ['actual', 'checked', 'reject']);
  } finally { await mf?.dispose(); rmSync(root, { recursive: true, force: true }); }
});
