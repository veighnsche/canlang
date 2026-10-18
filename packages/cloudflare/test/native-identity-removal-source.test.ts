/** Original fixed standard-event source, actual installed loader and real D1.
 * Reuses Identity's accepted atomic/read-only component controls; this test
 * qualifies the private Dev -> retained Work -> canonical State consumer join.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CommitBatch, ModelName, RecordId, StoragePort, WorkScope } from '@canlang/contracts';
import type { IdentityD1Database, IdentityD1BoundStatement } from '@canlang/identity';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const require = createRequire(import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const producer = (specifier: string) => pathToFileURL(require.resolve(specifier)).href;
const APP = 'NativeIdentityRemoval', EVENT = 'teams.member_removed', HANDLER = `${APP}.observed`;
const MODEL = `${APP}.Removal` as ModelName;
const fixture = join(root, 'packages/cloudflare/test/fixtures/native-identity-removal-source.can');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function snapshot(db: D1Database) {
  const names = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{ name: string }>();
  assert.equal(names.success, true);
  const result: Record<string, Array<Record<string, unknown>>> = {};
  for (const { name } of names.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    result[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
function hold() {
  let begin!: () => void, release!: () => void;
  const started = new Promise<void>(done => { begin = done; });
  const released = new Promise<void>(done => { release = done; });
  return { begin, release, started, released };
}

test('original native Identity removal preserves subject, cold SELECT-only recovery and current receiving lifetime',
  { timeout: 180000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-native-identity-removal-'));
    let worker: Miniflare | undefined;
    const openSources: Array<{ close(): void }> = [];
    const pendingCalls: Promise<unknown>[] = [];
    const pendingGates: Array<ReturnType<typeof hold>> = [];
    const blockingRead = () => { const gate = hold(); pendingGates.push(gate); return gate; };
    let readGate: ReturnType<typeof hold> | undefined;
    try {
      // All private capabilities/registries are instantiated by the authentic
      // installed default loader, including every Work system-command producer.
      const { assembleModules, importVerifiedAssemblyModule } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { createTeamOwnerStorageBoundary } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { createCanonicalIdentityRemovalSource, invokeRetainedHandlerOccurrenceCanonical } = await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
      const { prepareLocalPreviewCapture } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { captureSingleFileSource, captureIsCurrent, verifyCompilerSources } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { compileCapturedSingleFile } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } = await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
      const { createD1OwnerRouter } = await nodeImport(producer('@canlang/state/storage/owner-router')) as typeof import('@canlang/state/storage/owner-router');
      const { WORK_OCCURRENCE_MODEL, readOccurrenceRow } = await nodeImport(producer('@canlang/work/kernel/tables')) as typeof import('@canlang/work/kernel/tables');
      const { WORK_HANDLER_OCCURRENCE_MODEL, handlerOccurrenceRowId, readHandlerOccurrenceRow } = await nodeImport(producer('@canlang/work/kernel/handler-occurrence')) as typeof import('@canlang/work/kernel/handler-occurrence');
      const { distribution } = await nodeImport(producer('@canlang/values/distribution')) as typeof import('@canlang/values/distribution');
      const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
      const originalInputs = await Promise.all([fixture, compiler, catalog].map(async path => digest(await readFile(path))));
      const capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root, appPath: fixture,
        compilerPath: compiler, catalogPath: catalog, helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('The original teams.member_removed source/profile did not compile.');
      const artifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      assert.equal(artifact.sources.find(source => resolve(source.path) === fixture)?.sha256, originalInputs[0]);
      assert.equal(artifact.pages.length, 0);
      assert.equal(artifact.operations?.some(operation => operation.name === HANDLER), false);
      const callable = artifact.callables.find(callable => callable.id === HANDLER); assert.ok(callable);
      assert.equal(callable.kind, 'handler'); assert.deepEqual(callable.member, [HANDLER]);
      const asm = await assembleModules({ artifact, sourcePath: fixture }, { workDir: join(directory, 'modules'),
        stdlibUrl: installed('runtime/stdlib.js') });
      const namespace = object(await importVerifiedAssemblyModule(asm, callable.module, artifact));
      assert.equal(namespace[callable.export], HANDLER);
      const definition = object(namespace.appDefinition), operation = object(object(definition.operations)[HANDLER]);
      assert.equal(definition.id, APP); assert.equal(operation.event, EVENT); assert.equal(operation.handler, HANDLER);
      assert.deepEqual(object(object(operation.invocation).inputs).fields, [
        { name: 'team_id', field: { kind: 'string' }, valueType: 'text', required: true },
        { name: 'membership_id', field: { kind: 'string' }, valueType: 'text', required: true },
        { name: 'user', field: { kind: 'user' }, valueType: 'user', required: true },
      ]);
      assert.deepEqual(object(object(definition.events)[EVENT]).inputs,
        { team_id: { type: 'text' }, membership_id: { type: 'text' }, user: { type: 'user' } });
      const stagedBytes = new Map(await Promise.all(Object.entries(asm.moduleUrls).map(async ([path, url]) =>
        [path, await readFile(fileURLToPath(url))] as const)));
      const start = () => new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { IDENTITY: 'removal-identity', OWNER: 'removal-owner', FOREIGN: 'removal-foreign' },
        d1Persist: join(directory, 'd1') });
      worker = start();
      let identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      let ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      let foreignDb = await worker.getD1Database('FOREIGN') as unknown as D1Database;
      await ensureIdentitySchema(identityDb);
      const now = Date.parse('2026-10-11T12:00:00Z'), clock = { nowMs: () => now };
      let identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' }), otherTeam = await identities.createTeam({ timezone: 'UTC' });
      const remover = await identities.createUser({ email: 'remover@native-removal.example.test', password_hash: 'unused', email_verified: true });
      const subject = await identities.createUser({ email: 'subject@native-removal.example.test', password_hash: 'unused', email_verified: true });
      const removerMembership = await identities.createMembership({ team_id: team.team_id, user_id: remover.user_id, is_owner: true, roles: [] });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: subject.user_id, is_owner: false, roles: [] });
      const replacementOwner = await identities.createUser({ email: 'replacement-owner@native-removal.example.test', password_hash: 'unused', email_verified: true });
      await identities.createMembership({ team_id: team.team_id, user_id: replacementOwner.user_id, is_owner: true, roles: [] });
      assert.notEqual(subject.user_id, remover.user_id);
      const token = 'original-removal-credential';
      await identities.createSession({ user_id: remover.user_id, token_sha256: await sha256HexText(token),
        last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
      const currentCaller = () => resolveIdentity(identities, { session_token: token }, { clock });
      const scope: WorkScope = { app: APP, owner: team.team_id, ownerPackage: APP };
      const binding = { namespace: 'installed.native-removal', adapter: 'identity.atomic-member-removal', team: team.team_id, owner: team.team_id };
      const cause = (operationId: string) => Object.freeze({ team_id: team.team_id, member_user_id: subject.user_id,
        removed_by: remover.user_id, namespace: binding.namespace, operationId });
      let mounted = true;
      let ownerAdmissionGate: ReturnType<typeof hold> | undefined;
      const batches: CommitBatch[] = [];
      async function receivingBoundary(receiver: typeof identities) {
        const genuine = createD1OwnerRouter({ resolveBinding: selected => selected.app === APP &&
          [team.team_id, otherTeam.team_id].includes(selected.owner) && (selected.owner !== team.team_id || mounted)
          ? { ...selected, db: selected.owner === team.team_id ? ownerDb : foreignDb, initializeFresh: true } : null });
        const retained = new Map<string, StoragePort>();
        const router = { async ownerScopedStoragePort(selected: { app: string; owner: string }) {
          // Recheck the actual current route/persisted owner pin on EVERY call,
          // then retain the literal original physical receiver for this binding.
          const checked = await genuine.ownerScopedStoragePort(selected);
          let store = retained.get(selected.owner);
          if (store === undefined) {
            const commit = checked.commit;
            checked.commit = async batch => { const result = await commit.call(checked, batch); batches.push(batch); return result; };
            retained.set(selected.owner, store = checked);
          }
          if (selected.owner === team.team_id && ownerAdmissionGate !== undefined) {
            const held = ownerAdmissionGate; ownerAdmissionGate = undefined;
            held.begin(); await held.released;
          }
          return store;
        } };
        return createTeamOwnerStorageBoundary({ artifact, asm, app: APP, identities: receiver, router });
      }
      let boundary = await receivingBoundary(identities);
      let store = (await boundary.forTrustedScope(scope, now)).store;
      let foreign = (await boundary.forTrustedScope({ ...scope, owner: otherTeam.team_id }, now)).store;
      const resources = async () => ({ identity: await snapshot(identityDb), owner: await snapshot(ownerDb), foreign: await snapshot(foreignDb) });
      const source = async (originalRequest: ReturnType<typeof cause>, caller = currentCaller) => {
        const host = await createCanonicalIdentityRemovalSource({ asm, artifact, app: APP, identities, ownerStorage: boundary,
          scope, binding, originalRequest, resolveCaller: caller, now: clock.nowMs });
        openSources.push(host); return host;
      };
      const row = async (model: ModelName, id: string) => {
        const found = await store.load(model, id as RecordId); assert.ok(found); return found;
      };
      async function issued(originalRequest: ReturnType<typeof cause>) {
        assert.ok(identities.readMemberRemovalOccurrence);
        const original = await identities.readMemberRemovalOccurrence(originalRequest); assert.ok(original);
        assert.ok(Object.isFrozen(original)); assert.ok(Object.isFrozen(original.membershipRemoval));
        assert.ok(Object.isFrozen(original.membershipRemoval.user)); assert.ok(Object.isFrozen(original.removedBy));
        assert.equal(original.operationKind, EVENT); assert.equal(original.deliveryId, null);
        assert.equal(original.namespace, binding.namespace); assert.equal(original.operationId, originalRequest.operationId);
        assert.equal(original.membershipRemoval.user.id, subject.user_id); assert.equal(original.removedBy.id, remover.user_id);
        assert.equal(original.membershipRemoval.membership_id, membership.membership_id);
        const saved = await identityDb.prepare('SELECT event_id,namespace,operation_id,request_digest,team_id,membership_id,user_id,removed_by,occurred_at FROM identity_member_removals WHERE namespace=? AND operation_id=?')
          .bind(binding.namespace, originalRequest.operationId).first();
        assert.deepEqual(saved, { event_id: original.producerEventId, namespace: original.namespace, operation_id: original.operationId,
          request_digest: original.requestDigest, team_id: team.team_id, membership_id: membership.membership_id,
          user_id: subject.user_id, removed_by: remover.user_id, occurred_at: original.occurredAt });
        return original;
      }
      async function readback(original: Awaited<ReturnType<typeof issued>>, state: 'pending' | 'completed') {
        const handlerId = handlerOccurrenceRowId(original.producerEventId, HANDLER);
        const receipt = readOccurrenceRow(await row(WORK_OCCURRENCE_MODEL, original.producerEventId));
        assert.equal(receipt.status, 'completed'); assert.equal(receipt.code, null); assert.equal(receipt.message, null);
        assert.deepEqual(receipt.result, { kind: 'identity-removal-source', event: EVENT, scope, envelope: original,
          handlers: [{ handler: HANDLER, kind: 'ordinary', occurrenceId: handlerId }] });
        const handler = readHandlerOccurrenceRow(await row(WORK_HANDLER_OCCURRENCE_MODEL, handlerId));
        assert.equal(handler.state, state); assert.equal(handler.handler, HANDLER); assert.equal(handler.event, EVENT);
        assert.equal(handler.sourceOccurrence, original.producerEventId); assert.deepEqual(handler.payload,
          { ...original.membershipRemoval, user: { id: original.membershipRemoval.user.id } });
        assert.equal(handler.scopeApp, APP); assert.equal(handler.scopeOwner, team.team_id); assert.equal(handler.scopeOwnerPackage, APP);
        const terminal = await store.load(WORK_OCCURRENCE_MODEL, handlerId as RecordId);
        if (state === 'pending') assert.equal(terminal, null);
        else { assert.ok(terminal); assert.equal(readOccurrenceRow(terminal).status, 'completed'); }
      }
      async function runBody(host: Awaited<ReturnType<typeof source>>, original: Awaited<ReturnType<typeof issued>>) {
        const before = await resources(), count = batches.length, revision = await store.readRevision();
        assert.equal(object(await host.invoke(HANDLER)).status, 'completed');
        assert.equal(batches.length, count + 1); const batch = batches.at(-1)!;
        assert.equal(batch.expectedRevision, revision); assert.equal(await store.readRevision(), Number(revision) + 1);
        assert.ok(batch.receipt); assert.equal(batch.receipt.identity.principal, `identity:${EVENT}`);
        assert.equal(batch.receipt.identity.app, APP); assert.equal(batch.receipt.identity.owner, team.team_id);
        assert.equal(batch.receipt.identity.operation, HANDLER);
        assert.deepEqual(await store.readReceipt(batch.receipt.identity), JSON.parse(JSON.stringify(batch.receipt)));
        const business = batch.writes.filter(write => write.model === MODEL);
        assert.equal(business.length, 1); const write = business[0]!; assert.equal(write.kind, 'insert');
        if (write.kind !== 'insert') throw new Error('Original native removal body did not insert its declared model.');
        assert.deepEqual(write.row.data, { subject: { id: subject.user_id }, team: team.team_id, membership: membership.membership_id });
        assert.equal(write.row.createdBy, `identity:${EVENT}`); assert.equal(write.row.updatedBy, `identity:${EVENT}`);
        assert.deepEqual(await store.load(MODEL, write.row.id), write.row);
        assert.equal(batch.history.length, 1); assert.equal(batch.history[0]!.actor, `identity:${EVENT}`);
        assert.equal(batch.history[0]!.operation, HANDLER); assert.equal(batch.history[0]!.operationId, batch.receipt.identity.operationId);
        assert.equal(batch.history[0]!.change, 'create'); assert.deepEqual(batch.history[0]!.after, write.row.data);
        assert.deepEqual(await store.historyFor(MODEL, write.row.id), batch.history);
        assert.deepEqual(batch.writes.filter(write => write.model !== MODEL).map(write => [write.model, write.kind]),
          [[WORK_HANDLER_OCCURRENCE_MODEL, 'update'], [WORK_OCCURRENCE_MODEL, 'insert']]);
        for (const key of ['outbox', 'schedules', 'uniqueClaims', 'uniqueReleases', 'outboxAck'] as const) assert.deepEqual(batch[key] ?? [], []);
        const after = await resources(); assert.deepEqual(after.identity, before.identity); assert.deepEqual(after.foreign, before.foreign);
        for (const name of Object.keys(before.owner)) if (!['records', 'history', 'receipts', 'fence', 'fence_log', 'sqlite_sequence'].includes(name))
          assert.deepEqual(after.owner[name], before.owner[name], name);
        const changedKeys = new Set(batch.writes.map(write => `${write.model}\0${write.kind === 'remove' ? write.id : write.row.id}`));
        const untouched = (rows: Array<Record<string, unknown>>) => rows.filter(row => !changedKeys.has(`${row.model}\0${row.id}`));
        assert.deepEqual(untouched(after.owner.records!), untouched(before.owner.records!));
        const priorSeq = before.owner.history!.reduce((max, row) => Math.max(max, Number(row.seq)), 0);
        assert.deepEqual(after.owner.history!.filter(row => Number(row.seq) <= priorSeq), before.owner.history);
        assert.equal(after.owner.history!.length, before.owner.history!.length + 1);
        assert.deepEqual(after.owner.receipts!.filter(row => row.operation_id !== batch.receipt!.identity.operationId), before.owner.receipts);
        assert.equal(after.owner.receipts!.length, before.owner.receipts!.length + 1);
        await readback(original, 'completed');
        assert.equal(object(await host.invoke(HANDLER)).status, 'replayed');
        assert.deepEqual(await resources(), after); assert.equal(batches.length, count + 1);
      }
      // Both boundaries delay an actual granting read, then close the original
      // host. Issuance must refuse BEFORE removal or journal/Work effects.
      for (const boundaryHeld of ['credential', 'owner'] as const) {
        const closeGate = blockingRead(), closedRequest = cause(`closed-before-issue-${boundaryHeld}`);
        const closedSource = await source(closedRequest, boundaryHeld === 'credential' ? async () => {
          const caller = await currentCaller(); closeGate.begin(); await closeGate.released; return caller;
        } : currentCaller);
        const before = await resources(), batchCount = batches.length;
        if (boundaryHeld === 'owner') ownerAdmissionGate = closeGate;
        const attempt = assert.rejects(() => closedSource.issue()); pendingCalls.push(attempt);
        await closeGate.started; closedSource.close(); closeGate.release(); await attempt;
        assert.deepEqual(await resources(), before); assert.equal(batches.length, batchCount);
        assert.equal((await identities.findMembership(team.team_id, subject.user_id))?.status, 'active');
        assert.equal(await identities.readMemberRemovalOccurrence!(closedRequest), null);
      }
      const explicitRequest = cause('explicit-original'), explicit = await source(explicitRequest);
      assert.equal((await explicit.issue()).status, 'completed'); const first = await issued(explicitRequest);
      assert.equal((await identities.findMembership(team.team_id, subject.user_id))?.status, 'removed');
      await readback(first, 'pending'); await runBody(explicit, first); explicit.close();

      // A genuine original command commits, but its caller loses the response
      // before any Work routing. Recovery retains only the exact original five
      // arguments, not a JSON-issued envelope or a cached granting Identity.
      await identities.reactivateMembership(membership.membership_id, { is_owner: false, roles: [] });
      const lostRequest = cause('lost-ack-original'); assert.ok(identities.removeMemberWithOccurrence);
      await assert.rejects(async () => { await identities.removeMemberWithOccurrence!(lostRequest); throw new Error('local transport lost ACK'); }, /local transport lost ACK/);
      const lost = await issued(lostRequest);
      assert.equal(await store.load(WORK_OCCURRENCE_MODEL, lost.producerEventId as RecordId), null);
      // The original remover loses current membership before receiving/recovery.
      // That cause remains attribution; trusted receiving admission is fresh
      // and null-actor, without borrowing this saved originating credential.
      await identities.removeMembership(removerMembership.membership_id);
      assert.equal((await identities.findMembership(team.team_id, remover.user_id))?.status, 'removed');
      const beforeCold = await resources();
      for (const open of openSources) open.close();
      await worker.dispose(); worker = undefined;
      worker = start();
      identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      foreignDb = await worker.getD1Database('FOREIGN') as unknown as D1Database;
      const identityWrites: string[] = [];
      // Actual SELECT results/receiver are preserved. Deliberately omit batch:
      // the owning constructor exposes its released reader but NO command.
      const readOnlyDb: IdentityD1Database = { exec: sql => { identityWrites.push(sql); return identityDb.exec(sql); },
        prepare(sql) { return { bind(...values) {
          const bound = identityDb.prepare(sql).bind(...values);
          const first: IdentityD1BoundStatement['first'] = async <T>(column?: string): Promise<T | null> => {
            const value = column === undefined ? await bound.first<T>() : await bound.first<T>(column);
            if (/^SELECT namespace, operation_id, request_digest/.test(sql) && readGate !== undefined) {
              const held = readGate; readGate = undefined; held.begin(); await held.released;
            }
            return value;
          };
          return { first, all: <T>() => bound.all<T>(), run: <T>() => { identityWrites.push(sql); return bound.run<T>(); } };
        } }; } };
      identities = createD1IdentityStore(readOnlyDb, { clock });
      assert.equal(identities.removeMemberWithOccurrence, undefined); assert.equal(typeof identities.readMemberRemovalOccurrence, 'function');
      boundary = await receivingBoundary(identities);
      store = (await boundary.forTrustedScope(scope, now)).store;
      foreign = (await boundary.forTrustedScope({ ...scope, owner: otherTeam.team_id }, now)).store;
      assert.deepEqual(await resources(), beforeCold);
      const noOriginFallback = async () => { throw new Error('Cold recovery must not resolve an originating saved credential.'); };
      const recovered = await source(lostRequest, noOriginFallback);
      const beforeRecovery = await resources(), routeBatches = batches.length;
      assert.equal((await recovered.recover()).status, 'completed'); assert.equal(batches.length, routeBatches + 1);
      const routed = await resources(); assert.deepEqual(routed.identity, beforeRecovery.identity); assert.deepEqual(routed.foreign, beforeRecovery.foreign);
      const routeBatch = batches.at(-1)!;
      assert.equal(routeBatch.receipt, null); assert.deepEqual(routeBatch.history, []);
      assert.deepEqual(routeBatch.writes.map(write => [write.model, write.kind]),
        [[WORK_HANDLER_OCCURRENCE_MODEL, 'insert'], [WORK_OCCURRENCE_MODEL, 'insert']]);
      for (const key of ['outbox', 'schedules', 'uniqueClaims', 'uniqueReleases', 'outboxAck'] as const) assert.deepEqual(routeBatch[key] ?? [], []);
      await readback(lost, 'pending'); await runBody(recovered, lost);
      const mutationStore = createD1IdentityStore(identityDb, { clock });
      await mutationStore.reactivateMembership(membership.membership_id, { is_owner: false, roles: [] });
      const readmitted = await resources(), counts = batches.length;
      for (let replay = 0; replay < 2; replay++) {
        assert.equal((await recovered.recover()).status, 'replayed'); assert.equal(object(await recovered.invoke(HANDLER)).status, 'replayed');
        assert.deepEqual(await resources(), readmitted); assert.equal(batches.length, counts);
      }
      assert.equal((await identities.findMembership(team.team_id, subject.user_id))?.status, 'active');
      assert.deepEqual(identityWrites, [], 'cold read/consume/recover never invokes an Identity mutation');
      const noEffects = async (action: () => Promise<unknown>) => {
        const before = await resources(), count = batches.length;
        await assert.rejects(action); assert.deepEqual(await resources(), before); assert.equal(batches.length, count);
      };
      const selector = { sourceOccurrence: lost.producerEventId, handler: HANDLER, event: EVENT, scope };
      const invoke = (overrides: Partial<Parameters<typeof invokeRetainedHandlerOccurrenceCanonical>[0]> = {}) =>
        invokeRetainedHandlerOccurrenceCanonical({ asm, artifact, app: APP, store, identities, selector, now: clock.nowMs, ...overrides });
      // JSON copies cannot install an original receiver/artifact association;
      // the exact original source selector cannot move to a foreign store.
      await noEffects(() => invoke({ identities: { ...identities } }));
      await noEffects(() => invoke({ artifact: structuredClone(artifact) }));
      await noEffects(() => invoke({ store: foreign }));
      await noEffects(() => invoke({ selector: { ...selector, sourceOccurrence: 'absent-original-occurrence' } }));
      const absent = await source(cause('never-issued'), noOriginFallback); await noEffects(() => absent.recover()); absent.close();
      const skew = await source({ ...lostRequest, member_user_id: remover.user_id }, noOriginFallback); await noEffects(() => skew.recover()); skew.close();
      const foreignBinding = { ...binding, namespace: 'foreign.installed.namespace' };
      await noEffects(async () => { const foreignSource = await createCanonicalIdentityRemovalSource({ asm, artifact, app: APP, identities,
        ownerStorage: boundary, scope, binding: foreignBinding, originalRequest: { ...lostRequest, namespace: foreignBinding.namespace },
        resolveCaller: noOriginFallback, now: clock.nowMs }); openSources.push(foreignSource); await foreignSource.recover(); });
      mounted = false; await noEffects(() => recovered.recover()); await noEffects(() => recovered.invoke(HANDLER)); mounted = true;
      recovered.close(); await noEffects(() => invoke()); await noEffects(() => recovered.recover());
      const pending = await source(lostRequest, noOriginFallback);
      const held = blockingRead(); readGate = held;
      const baseline = await resources(), priorBatches = batches.length;
      const inFlight = assert.rejects(() => pending.invoke(HANDLER)); pendingCalls.push(inFlight);
      await held.started; pending.close(); held.release(); await inFlight;
      assert.deepEqual(await resources(), baseline); assert.equal(batches.length, priorBatches);
      const pendingRevoke = await source(lostRequest, noOriginFallback), revokeGate = blockingRead(); readGate = revokeGate;
      const revokeBefore = await resources(), revokeCount = batches.length;
      const revokedFlight = assert.rejects(() => pendingRevoke.recover()); pendingCalls.push(revokedFlight);
      await revokeGate.started; mounted = false; revokeGate.release(); await revokedFlight;
      assert.deepEqual(await resources(), revokeBefore); assert.equal(batches.length, revokeCount); mounted = true; pendingRevoke.close();
      const changedSource = await source(lostRequest, noOriginFallback);
      const stagedPath = fileURLToPath(asm.moduleUrls[callable.module]!);
      const originalJs = await readFile(stagedPath);
      try { await writeFile(stagedPath, Buffer.concat([originalJs, Buffer.from('\n// owned staged-module currency control\n')]));
        await noEffects(() => changedSource.recover()); }
      finally { await writeFile(stagedPath, originalJs); changedSource.close(); }
      assert.deepEqual(identityWrites, []);
      assert.equal(JSON.stringify(artifact), originalArtifact);
      assert.deepEqual(await Promise.all([fixture, compiler, catalog].map(async path => digest(await readFile(path)))), originalInputs);
      assert.equal(await captureIsCurrent(capture), true);
      for (const [path, bytes] of stagedBytes) assert.deepEqual(await readFile(fileURLToPath(asm.moduleUrls[path]!)), bytes);
      assert.deepEqual(await foreign.query({ model: MODEL, authority: 'owner' }), []);
      assert.equal((await store.query({ model: MODEL, authority: 'owner' })).length, 2);
    } finally {
      // Capture owns immutable observations, not a disposable resource. Every
      // real host lifetime and workerd/database is closed before owned removal.
      for (const gate of pendingGates) gate.release();
      for (const source of openSources) source.close();
      await Promise.allSettled(pendingCalls);
      try { await worker?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
