/** Actual local native signed-ingress consumer control. The unchanged source, genuine
 * Identity journal, installed Interfaces verifier and canonical Work/State body
 * are exercised together; library-owned syntax permutations remain reused. */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
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

test('original signed Identity ingress preserves raw bytes, cold recovery, null actor and final receiving admission',
  { timeout: 180000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-native-identity-ingress-'));
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
      const { handleIngressRequest } = await nodeImport(producer('@canlang/interfaces')) as typeof import('@canlang/interfaces');
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
      let now = Date.parse('2026-10-11T12:00:00Z'); const clock = { nowMs: () => now };
      let identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' }), otherTeam = await identities.createTeam({ timezone: 'UTC' });
      const remover = await identities.createUser({ email: 'remover@native-removal.example.test', password_hash: 'unused', email_verified: true });
      const subject = await identities.createUser({ email: 'subject@native-removal.example.test', password_hash: 'unused', email_verified: true });
      const removerMembership = await identities.createMembership({ team_id: team.team_id, user_id: remover.user_id, is_owner: true, roles: [] });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: subject.user_id, is_owner: false, roles: [] });
      const replacementOwner = await identities.createUser({ email: 'replacement-owner@native-removal-ingress.example.test', password_hash: 'unused', email_verified: true });
      await identities.createMembership({ team_id: team.team_id, user_id: replacementOwner.user_id, is_owner: true, roles: [] });
      assert.notEqual(subject.user_id, remover.user_id);
      const token = 'original-removal-credential';
      await identities.createSession({ user_id: remover.user_id, token_sha256: await sha256HexText(token),
        last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
      const currentCaller = () => resolveIdentity(identities, { session_token: token }, { clock });
      const scope: WorkScope = { app: APP, owner: team.team_id, ownerPackage: APP };
      const binding = { namespace: 'installed.native-removal', adapter: 'standard-webhooks-v1-identity-removal', team: team.team_id, owner: team.team_id };
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
      const key = randomBytes(32), replacementKey = randomBytes(32);
      let publishedKeys: { current: string; previous?: string } | null = { current: `whsec_${key.toString('base64')}` };
      let profileCurrent = true;
      const ingress = { keys: () => publishedKeys, isCurrent: () => profileCurrent };
      const source = async (originalRequest: ReturnType<typeof cause>, caller = currentCaller, signed = true) => {
        const host = await createCanonicalIdentityRemovalSource({ asm, artifact, app: APP, identities, ownerStorage: boundary,
          scope, binding, originalRequest, resolveCaller: caller, now: clock.nowMs, ...(signed ? { ingress } : {}) });
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
          handlers: [{ handler: HANDLER, kind: 'ordinary', occurrenceId: handlerId }],
          ingress: { profile: binding, rawBodySha256: digest(body(original)) } });
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
      type Original = Awaited<ReturnType<typeof issued>>;
      type Host = Awaited<ReturnType<typeof source>>;
      const body = (original: Original) => Buffer.from(JSON.stringify(original));
      const headers = (original: Original, raw = body(original), signingKey = key, timestamp = Math.floor(now / 1000)) => {
        const prefix = `${original.producerEventId}.${timestamp}.`;
        const signature = createHmac('sha256', signingKey).update(prefix).update(raw).digest('base64');
        return { 'webhook-id': original.producerEventId, 'webhook-timestamp': String(timestamp), 'webhook-signature': `v1,${signature}` };
      };
      const logs: Array<{ level: string; message: string; fields: Record<string, unknown> | undefined }> = [];
      const logger: import('@canlang/interfaces').Logger = { log: (level, message, fields) => { logs.push({ level, message, fields }); } };
      const ports = (host: Host) => { assert.ok(host.ingress); return host.ingress; };
      const request = (original: Original, raw = body(original), signedHeaders = headers(original, raw)) =>
        new Request(`http://local.invalid/ingress/${encodeURIComponent(binding.namespace)}`, {
          method: 'POST', headers: signedHeaders, body: new Uint8Array(raw),
        });
      const deliver = (host: Host, original: Original, raw = body(original), signedHeaders = headers(original, raw)) =>
        handleIngressRequest({ ...ports(host), logger, clock }, request(original, raw, signedHeaders));
      const accepted = async (response: Response, original: Original) => {
        assert.equal(response.status, 200); assert.deepEqual(await response.json(), { accepted: true, producer_event_id: original.producerEventId });
      };
      const refused = async (response: Response) => {
        if (response.status === 200) assert.equal(object(await response.json()).accepted, false);
        else assert.ok([401, 404, 500].includes(response.status), `unexpected native refusal ${response.status}`);
      };
      const noEffects = async (action: () => Promise<void>) => {
        const before = await resources(), count = batches.length;
        await action(); assert.deepEqual(await resources(), before); assert.equal(batches.length, count);
      };
      // Genuine Identity commands occur before receiving installation. No JSON
      // envelope, incoming signature or originating credential issues a cause.
      async function remove(operationId: string) {
        await identities.reactivateMembership(membership.membership_id, { is_owner: false, roles: [] });
        const originalRequest = cause(operationId); assert.ok(identities.removeMemberWithOccurrence);
        await identities.removeMemberWithOccurrence(originalRequest);
        return { originalRequest, original: await issued(originalRequest) };
      }
      const signed = await remove('signed-original');
      const legacy = await remove('legacy-original');
      const legacyHost = await source(legacy.originalRequest, currentCaller, false);
      assert.equal((await legacyHost.recover()).status, 'completed');
      const legacyResult = readOccurrenceRow(await row(WORK_OCCURRENCE_MODEL, legacy.original.producerEventId)).result;
      assert.equal(Object.keys(object(legacyResult)).length, 5); assert.equal(object(legacyResult).ingress, undefined);
      legacyHost.close();
      const unreceived = await remove('signed-final-admission');
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
      assert.equal(identities.removeMemberWithOccurrence, undefined);
      boundary = await receivingBoundary(identities);
      store = (await boundary.forTrustedScope(scope, now)).store;
      foreign = (await boundary.forTrustedScope({ ...scope, owner: otherTeam.team_id }, now)).store;
      assert.deepEqual(await resources(), beforeCold);
      const noOriginFallback = async () => { throw new Error('Signed SELECT-only reception must never borrow originating credentials.'); };
      const host = await source(signed.originalRequest, noOriginFallback);
      const beforeRoute = await resources(), routeCount = batches.length, routeR = await store.readRevision();
      await accepted(await deliver(host, signed.original), signed.original);
      assert.equal(batches.length, routeCount + 1); assert.equal(await store.readRevision(), Number(routeR) + 1);
      const routeBatch = batches.at(-1)!; assert.equal(routeBatch.expectedRevision, routeR);
      assert.equal(routeBatch.receipt, null); assert.deepEqual(routeBatch.history, []);
      assert.deepEqual(routeBatch.writes.map(write => [write.model, write.kind]),
        [[WORK_HANDLER_OCCURRENCE_MODEL, 'insert'], [WORK_OCCURRENCE_MODEL, 'insert']]);
      for (const k of ['outbox', 'schedules', 'uniqueClaims', 'uniqueReleases', 'outboxAck'] as const) assert.deepEqual(routeBatch[k] ?? [], []);
      const afterRoute = await resources(); assert.deepEqual(afterRoute.identity, beforeRoute.identity); assert.deepEqual(afterRoute.foreign, beforeRoute.foreign);
      assert.deepEqual(afterRoute.owner.history, beforeRoute.owner.history); assert.deepEqual(afterRoute.owner.receipts, beforeRoute.owner.receipts);
      for (const name of Object.keys(beforeRoute.owner)) if (!['records', 'fence', 'fence_log'].includes(name))
        assert.deepEqual(afterRoute.owner[name], beforeRoute.owner[name], name);
      const sourceKeys = new Set(routeBatch.writes.map(write => `${write.model}\0${write.kind === 'remove' ? write.id : write.row.id}`));
      const outsideSource = (rows: Array<Record<string, unknown>>) => rows.filter(row => !sourceKeys.has(`${row.model}\0${row.id}`));
      assert.deepEqual(outsideSource(afterRoute.owner.records!), outsideSource(beforeRoute.owner.records!));
      for (const write of routeBatch.writes) { assert.notEqual(write.kind, 'remove');
        if (write.kind !== 'remove') assert.deepEqual(await store.load(write.model, write.row.id), write.row); }
      await readback(signed.original, 'pending');
      // Retiring the transport key cannot retire an already accepted source or
      // handler replay. Every NEW transport verification uses current keys.
      publishedKeys = { current: `whsec_${replacementKey.toString('base64')}` };
      await runBody(host, signed.original);
      await noEffects(async () => { await refused(await deliver(host, signed.original)); });
      await noEffects(async () => { await accepted(await deliver(host, signed.original, body(signed.original), headers(signed.original, body(signed.original), replacementKey)), signed.original); });
      host.close();
      // New cold installation FIRST sees cryptographically valid equivalent
      // JSON with different raw bytes. Failure must not poison this SAME host.
      const cold = await source(signed.originalRequest, noOriginFallback);
      const alternate = Buffer.from(JSON.stringify(signed.original, null, 1)); assert.notEqual(digest(alternate), digest(body(signed.original)));
      await noEffects(async () => { await refused(await deliver(cold, signed.original, alternate, headers(signed.original, alternate, replacementKey))); });
      now += 1000;
      await noEffects(async () => { await accepted(await deliver(cold, signed.original, body(signed.original), headers(signed.original, body(signed.original), replacementKey)), signed.original);
        assert.equal(object(await cold.invoke(HANDLER)).status, 'replayed'); });
      await readback(signed.original, 'completed');
      await noEffects(async () => {
        await refused(await deliver(cold, signed.original, alternate, headers(signed.original, alternate, replacementKey)));
        assert.equal(object(await cold.invoke(HANDLER)).status, 'replayed');
      });
      const retrofit = await source(legacy.originalRequest, noOriginFallback);
      await noEffects(async () => { await refused(await deliver(retrofit, legacy.original, body(legacy.original), headers(legacy.original, body(legacy.original), replacementKey))); });
      assert.deepEqual(readOccurrenceRow(await row(WORK_OCCURRENCE_MODEL, legacy.original.producerEventId)).result, legacyResult);
      retrofit.close();
      // Representative actual route/crypto/typed-original seams. The six owning
      // verifier groups cover all syntax permutations; these exercise D1/Work.
      const fresh = await source(unreceived.originalRequest, noOriginFallback), raw = body(unreceived.original);
      const signedNow = () => headers(unreceived.original, raw, replacementKey);
      for (const bad of [
        { ...signedNow(), 'webhook-timestamp': `${Math.floor(now / 1000)}, ${Math.floor(now / 1000)}` },
        { ...signedNow(), 'webhook-signature': `v1,${Buffer.alloc(32).toString('base64')}` },
        headers(unreceived.original, raw, replacementKey, Math.floor(now / 1000) - 301),
      ]) await noEffects(async () => { await refused(await deliver(fresh, unreceived.original, raw, bad)); });
      for (const event of [
        { ...unreceived.original, membershipRemoval: { ...unreceived.original.membershipRemoval, user: { kind: 'user', id: remover.user_id } } },
        { ...unreceived.original, removedBy: { kind: 'user', id: subject.user_id } },
        { ...unreceived.original, operationId: 'missing-native-journal' },
        { ...unreceived.original, extra: 'closed-shape' },
      ]) {
        const altered = Buffer.from(JSON.stringify(event));
        await noEffects(async () => { await refused(await deliver(fresh, unreceived.original, altered, headers(unreceived.original, altered, replacementKey))); });
      }
      const duplicate = Buffer.from(`{"namespace":${JSON.stringify(binding.namespace)},${raw.toString().slice(1)}`);
      const invalidUtf8 = Buffer.concat([raw.subarray(0, raw.length - 1), Buffer.from(',"extra":"'), Buffer.from([0xff]), Buffer.from('"}')]);
      for (const malformed of [duplicate, invalidUtf8]) await noEffects(async () => {
        await refused(await deliver(fresh, unreceived.original, malformed, headers(unreceived.original, malformed, replacementKey)));
      });
      // Exact private verifier pointer is needed by the paired sink; never
      // promote a JSON copy, altered null-actor context or foreign owner.
      const selected = ports(fresh).bindings.bindingFor(binding.namespace); assert.ok(selected);
      const verified = await ports(fresh).verifier.verify(selected, { headers: signedNow(), body: raw }); assert.ok(verified);
      assert.ok(Object.isFrozen(verified)); assert.deepEqual(verified, unreceived.original);
      const context = { actor: null, team: binding.team, owner: binding.owner, namespace: binding.namespace, causation: verified } as const;
      for (const alteredContext of [{ ...context, causation: structuredClone(verified) }, { ...context, owner: otherTeam.team_id }])
        await noEffects(async () => { assert.deepEqual(await ports(fresh).sink.accept(alteredContext, unreceived.original), { accepted: false }); });
      const selector = { sourceOccurrence: signed.original.producerEventId, handler: HANDLER, event: EVENT, scope };
      const invoke = (overrides: Partial<Parameters<typeof invokeRetainedHandlerOccurrenceCanonical>[0]> = {}) =>
        invokeRetainedHandlerOccurrenceCanonical({ asm, artifact, app: APP, store, identities, selector, now: clock.nowMs, ...overrides });
      for (const overrides of [{ identities: { ...identities } }, { artifact: structuredClone(artifact) }, { store: foreign }])
        await noEffects(async () => { await assert.rejects(() => invoke(overrides)); });
      const originalReader = identities.readMemberRemovalOccurrence!;
      try {
        identities.readMemberRemovalOccurrence = input => originalReader.call(identities, input);
        await noEffects(async () => { await refused(await deliver(fresh, unreceived.original, raw, signedNow())); });
      } finally { identities.readMemberRemovalOccurrence = originalReader; }
      const originalNow = now; now += 86400001;
      try { await noEffects(async () => { await refused(await deliver(fresh, unreceived.original, raw, signedNow())); }); }
      finally { now = originalNow; }
      mounted = false;
      await noEffects(async () => { await refused(await deliver(fresh, unreceived.original, raw, signedNow())); }); mounted = true;
      profileCurrent = false;
      await noEffects(async () => { await refused(await deliver(fresh, unreceived.original, raw, signedNow())); }); profileCurrent = true;
      // Hold a REAL original SELECT. Closing or key retirement before it
      // resumes cannot authenticate or stage a source/handler.
      for (const invalidate of ['close', 'key'] as const) {
        const pending = await source(unreceived.originalRequest, noOriginFallback), gate = blockingRead(); readGate = gate;
        const before = await resources(), count = batches.length;
        const flight = deliver(pending, unreceived.original, raw, signedNow()); pendingCalls.push(flight);
        await gate.started;
        if (invalidate === 'close') pending.close(); else publishedKeys = null;
        gate.release(); await refused(await flight);
        assert.deepEqual(await resources(), before); assert.equal(batches.length, count);
        publishedKeys = { current: `whsec_${replacementKey.toString('base64')}` }; pending.close();
      }
      // A genuine successful verifier is followed by a held physical-owner
      // admission in the ORIGINAL sink, then host/key/owner invalidation.
      for (const invalidate of ['close', 'key', 'owner'] as const) {
        const pending = await source(unreceived.originalRequest, noOriginFallback), p = ports(pending);
        const selected = p.bindings.bindingFor(binding.namespace); assert.ok(selected);
        const cause = await p.verifier.verify(selected, { headers: signedNow(), body: raw }); assert.ok(cause);
        const gate = blockingRead(), before = await resources(), count = batches.length; ownerAdmissionGate = gate;
        const flight = assert.rejects(() => p.sink.accept({ ...context, causation: cause }, unreceived.original)); pendingCalls.push(flight);
        await gate.started;
        if (invalidate === 'close') pending.close(); else if (invalidate === 'key') publishedKeys = null; else mounted = false;
        gate.release(); await flight;
        assert.deepEqual(await resources(), before); assert.equal(batches.length, count);
        publishedKeys = { current: `whsec_${replacementKey.toString('base64')}` }; mounted = true; pending.close();
      }
      // After the actual source cohort load selected R, a real competing empty
      // State commit changes R. The original source batch must fail atomically.
      const fenced = await source(unreceived.originalRequest, noOriginFallback), p = ports(fenced);
      const selectedFence = p.bindings.bindingFor(binding.namespace); assert.ok(selectedFence);
      const fenceCause = await p.verifier.verify(selectedFence, { headers: signedNow(), body: raw }); assert.ok(fenceCause);
      const load = store.cohortLoad, gate = blockingRead(); let heldOnce = false;
      store.cohortLoad = async input => {
        const result = await load.call(store, input);
        if (!heldOnce && input.model === WORK_OCCURRENCE_MODEL && input.id === unreceived.original.producerEventId) {
          heldOnce = true; gate.begin(); await gate.released;
        }
        return result;
      };
      try {
        const flight = assert.rejects(() => p.sink.accept({ ...context, causation: fenceCause }, unreceived.original)); pendingCalls.push(flight);
        await gate.started;
        const competingR = await store.readRevision();
        await store.commit({ expectedRevision: competingR, writes: [], history: [], receipt: null,
          outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [] });
        assert.equal(await store.readRevision(), Number(competingR) + 1);
        const before = await resources(), count = batches.length; gate.release(); await flight;
        assert.deepEqual(await resources(), before); assert.equal(batches.length, count);
        assert.equal(await store.load(WORK_OCCURRENCE_MODEL, unreceived.original.producerEventId as RecordId), null);
        assert.equal(await store.load(WORK_HANDLER_OCCURRENCE_MODEL, handlerOccurrenceRowId(unreceived.original.producerEventId, HANDLER) as RecordId), null);
      } finally { gate.release(); store.cohortLoad = load; fenced.close(); }
      const changed = await source(unreceived.originalRequest, noOriginFallback);
      const stagedPath = fileURLToPath(asm.moduleUrls[callable.module]!), originalJs = await readFile(stagedPath);
      try { await writeFile(stagedPath, Buffer.concat([originalJs, Buffer.from('\n// owned staged currency control\n')]));
        await noEffects(async () => { await refused(await deliver(changed, unreceived.original, raw, signedNow())); }); }
      finally { await writeFile(stagedPath, originalJs); changed.close(); }
      fresh.close(); cold.close();
      await noEffects(async () => { await assert.rejects(() => invoke()); });
      await noEffects(async () => { await refused(await deliver(fresh, unreceived.original, raw, signedNow())); });
      assert.deepEqual(identityWrites, [], 'receiving and cold replay have no Identity mutation/issuer fallback');
      assert.equal(JSON.stringify(artifact), originalArtifact);
      assert.deepEqual(await Promise.all([fixture, compiler, catalog].map(async path => digest(await readFile(path)))), originalInputs);
      assert.equal(await captureIsCurrent(capture), true);
      for (const [path, bytes] of stagedBytes) assert.deepEqual(await readFile(fileURLToPath(asm.moduleUrls[path]!)), bytes);
      assert.deepEqual(await foreign.query({ model: MODEL, authority: 'owner' }), []);
      assert.equal((await store.query({ model: MODEL, authority: 'owner' })).length, 1);
      // No signature/key/body material is put in a log carrier.
      const logged = JSON.stringify(logs); assert.equal(logged.includes(key.toString('base64')), false);
      assert.equal(logged.includes(replacementKey.toString('base64')), false);
      assert.equal(logged.includes(raw.toString()), false);
    } finally {
      for (const gate of pendingGates) gate.release();
      for (const source of openSources) source.close();
      await Promise.allSettled(pendingCalls);
      try { await worker?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
