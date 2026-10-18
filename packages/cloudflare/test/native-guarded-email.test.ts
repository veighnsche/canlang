/** Original Compiler -> native SEND -> real State/Work fence. No patched artifact or receipt mock. */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CapabilityCompletion, CompileArtifact, ModelChatReply, ModelRunSnapshot, MutationEnvelope, ProviderBinding, ReceiptIdentity } from '@canlang/contracts';
import type { InstalledMailSender, InstalledTextGeneration } from '@canlang/services';
import { createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity } from '@canlang/identity';
import { ensureSchema } from '@canlang/state/storage/d1';
import { asId, asModel, asOperation, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { RECEIPT_MODEL, RECEIPT_ASSOCIATION_MODEL, readReceiptRow, readAssociationRow } from '@canlang/state/receipt/tables';
import { readScenarioReceiptAssociation } from '@canlang/state/invocation';
import { createSqliteFileStore } from '@canlang/files/host/sqlite';
import { WORK_DISPATCH_MODEL, readDispatchRow } from '@canlang/work/kernel/tables';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const installedModule = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const APP = 'NativeGuardedEmail', MODEL = asModel(`${APP}.Entry`), NOW = Date.UTC(2026, 9, 11, 10);
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
async function snapshot(db: D1Database) {
  const names = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name: string}>();
  assert.equal(names.success, true);
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const {name} of names.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true); result[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
function gate() {
  let begin!: () => void, release!: () => void;
  return { started: new Promise<void>(done => { begin = done; }), released: new Promise<void>(done => { release = done; }),
    begin: () => begin(), release: () => release() };
}

test.each([
  { profile: 'private selected user Email', modelSnapshot: false, textGeneration: false, userMail: true, fixture: 'native-guarded-user-email.can' },
  { profile: 'scalar/nullable/array Email', modelSnapshot: false, textGeneration: false, fixture: 'native-guarded-email.can' },
  { profile: 'historical model snapshot Email', modelSnapshot: true, textGeneration: false, fixture: 'native-model-guarded-email.can' },
  { profile: 'current parent/reference behind historical Email snapshot', modelSnapshot: true, textGeneration: false,
    references: true, fixture: 'native-parent-model-guarded-email.can' },
  { profile: 'scalar/nullable/array TextGeneration', modelSnapshot: false, textGeneration: true, fixture: 'native-guarded-text-generation.can' },
])('original $profile SEND has source skip, fresh membership, one ACK fence and exact replay',
  { timeout: 120000 }, async ({modelSnapshot, textGeneration, fixture, references = false, userMail = false}) => {
    const mailTarget = userMail ? 'std.EmailV1.send_user' : 'std.EmailV1.send';
    const source = join(root, 'packages/cloudflare/test/fixtures', fixture);
    const {distribution: nativeDistribution} = await nodeImport(installedModule('distribution.js')) as typeof import('../src/distribution.js');
    const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(nativeDistribution.nativeCatalog);
    const paths = [source, compiler, catalog], originals = await Promise.all(paths.map(path => readFile(path)));
    const dir = await mkdtemp(join(tmpdir(), 'can-native-guarded-email-'));
    let worker: Miniflare | undefined, physical: ReturnType<typeof createSqliteFileStore> | undefined, sequence = 0, now = NOW;
    const clock = { nowMs: () => now }, nextId = () => asOperationId(uuidv7(now, ++sequence));
    try {
      const {assembleModules, importVerifiedAssemblyModule} = await nodeImport(installedModule('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const {buildInvoker} = await nodeImport(installedModule('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const {createBoundMailAdapter} = await nodeImport(installedModule('runtime/bound-mail.js')) as typeof import('../src/runtime/bound-mail.js');
      const {createBoundMailDispatcher, createBoundTextGenerationDispatcher} = await nodeImport(installedModule('runtime/bound-dispatch.js')) as typeof import('../src/runtime/bound-dispatch.js');
      const {createBoundTextGenerationAdapter} = await nodeImport(installedModule('runtime/bound-text-generation.js')) as typeof import('../src/runtime/bound-text-generation.js');
      const require = createRequire(import.meta.url);
      const {WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS, createWorkDispatchClaimCommand} =
        await nodeImport(pathToFileURL(require.resolve('@canlang/work/kernel/commands')).href) as typeof import('@canlang/work/kernel/commands');
      const {classifyFailure} = await nodeImport(pathToFileURL(require.resolve('@canlang/work/receipt')).href) as typeof import('@canlang/work/receipt');
      const {createNativeFileRetirementBinding} = await nodeImport(pathToFileURL(join(root, 'packages/cloudflare/dist/runtime/file-retirement.js')).href) as typeof import('../src/runtime/file-retirement.js');
      const {bindNativeEmailDispatchGuards} = await nodeImport(pathToFileURL(join(root, 'packages/cloudflare/dist/runtime/invoke.js')).href) as typeof import('../src/runtime/invoke.js');
      const env = {...process.env}; delete env.CAN_CATALOG;
      const {stdout} = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact, originalArtifact = JSON.stringify(artifact);
      assert.ok(artifact.sources.some(value => resolve(value.path) === source && value.sha256 === hash(originals[0]!)));
      const asm = await assembleModules({artifact, sourcePath: source}, {workDir: join(dir, 'modules'),
        stdlibUrl: installedModule('runtime/stdlib.js'), uiUrl: pathToFileURL(createRequire(import.meta.url).resolve('@canlang/ui')).href});
      const namespace = object(await importVerifiedAssemblyModule(asm, artifact.modules[0]!.path, artifact));
      const definition = object(namespace.appDefinition), guard = object((object(object(definition.operations)[`${APP}.deliver`]).sendGuards as unknown[])[0]);
      const lexicalInputs = guard.inputs as Array<{name: string; type: string}>;
      assert.deepEqual(lexicalInputs.filter(input => input.name === 'entry'), modelSnapshot ? [{name: 'entry', type: MODEL}] : []);
      assert.deepEqual(lexicalInputs.filter(input => input.name !== 'entry'), [{name: 'enabled', type: 'bool'}, {name: 'note', type: 'text?'},
        {name: 'values', type: 'int[]'}, {name: 'person', type: 'user'}]);
      const profile = object(guard.inputDeclaration);
      for (const fields of [profile.canonical, profile.artifact]) for (const field of fields as unknown[]) assert.equal(object(field).required, true);
      const rule = artifact.callables.find(value => value.id === guard.rule);
      assert.ok(rule); assert.equal(rule.kind, 'rule'); assert.deepEqual(rule.member, ['sendWhen', guard.rule]);
      assert.equal(namespace[rule.export], guard.rule);
      worker = new Miniflare({compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: {IDENTITY: 'email-identity', OWNER: 'email-owner'}, d1Persist: join(dir, 'd1')});
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database,
        db = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(db);
      const identities = createD1IdentityStore(identityDb, {clock}), team = await identities.createTeam({timezone: 'UTC'});
      const owner = await identities.createUser({email: 'email-owner@example.test', password_hash: 'unused', email_verified: true});
      const subject = await identities.createUser({email: 'email-subject@example.test', password_hash: 'unused', email_verified: true});
      await identities.createMembership({user_id: owner.user_id, team_id: team.team_id, is_owner: true, roles: []});
      let membership = await identities.createMembership({user_id: subject.user_id, team_id: team.team_id, is_owner: false, roles: []});
      const grant = await issueMcpGrant(identities, {user_id: owner.user_id, team_id: team.team_id, client_id: 'original-email'}, {clock});
      const currentIdentity = () => resolveIdentity(identities, {mcp_grant_token: grant.token}, {clock});
      physical = createSqliteFileStore(join(dir, 'files.sqlite'));
      const scope = {app: APP, ownerPackage: APP, owner: team.team_id};
      const native = await createNativeFileRetirementBinding({artifact, asm, scope, identities, db, stateStoreId: 'native-guarded-email',
        physicalSqliteFileStore: physical, initializeFresh: true, clock, intentTtlMs: 60000, urlBase: 'https://email.invalid',
        retention: {unattachedHorizonMs: 120000, retentionMs: 600000}, maxRows: 100, maxReferences: 100});
      // Original producers are bound before the first source invocation. Each drive receives a fresh fence.
      const fenceFor = await bindNativeEmailDispatchGuards({asm, artifact, store: native.store, identities, scope,
        revalidateAuthority: async () => (await identities.findTeamById(team.team_id))?.team_id === team.team_id});
      const invoker = buildInvoker(artifact, asm, native.store, {appId: APP, memberships: identities, now: clock.nowMs, ownerStorage: native.ownerStorage});
      const query = (model: string) => native.store.query({model: asModel(model), authority: 'owner', archived: 'include', order: [{field: 'id', direction: 'asc'}]});
      const receiptIdentity = (envelope: MutationEnvelope): ReceiptIdentity => ({app: APP, owner: team.team_id, principal: owner.user_id,
        operation: asOperation(envelope.operation), operationId: asOperationId(envelope.operation_id)});
      const profileModel = `${APP}.Profile`;
      let referenceProfile: import('@canlang/contracts').StoredRow | undefined;
      if (references) {
        const createdProfile = await invoker.invokeMutation({ operation: `${profileModel}.create`, operation_id: nextId(), inputs: {} }, await currentIdentity());
        assert.ok('result' in createdProfile, JSON.stringify(createdProfile));
        referenceProfile = (await query(profileModel))[0]!;
      }
      const create: MutationEnvelope = {operation: `${MODEL}.create`, operation_id: nextId(), inputs: referenceProfile === undefined ? {} : {
        parent: { id: referenceProfile.id, version: String(referenceProfile.version) },
        profile: { id: referenceProfile.id, version: String(referenceProfile.version) },
      }};
      const created = await invoker.invokeMutation(create, await currentIdentity()); assert.ok('result' in created, JSON.stringify(created));
      assert.equal(created.result.status, 'committed');
      let entry = (await query(MODEL))[0]!;
      const envelope = (enabled: boolean, accept = true): MutationEnvelope => ({operation: `${APP}.deliver`, operation_id: nextId(),
        inputs: {entry: {id: entry.id, version: String(entry.version)}, enabled, note: null, values: [], person: {id: subject.user_id}, accept}});
      const invoke = async (input: MutationEnvelope) => invoker.invokeMutation(input, await currentIdentity());
      const fileState = () => ({files: physical!.files.listAll(), intents: physical!.intents.listAll()});
      const filesBefore = fileState(), identitiesBefore = await snapshot(identityDb);
      const falseSource = envelope(false), sourceRevision = await native.store.readRevision();
      const skipped = await invoke(falseSource); assert.ok('result' in skipped, JSON.stringify(skipped)); assert.equal(skipped.result.status, 'committed');
      assert.equal(await native.store.readRevision(), sourceRevision + 1);
      assert.deepEqual(await query(WORK_DISPATCH_MODEL), []); assert.deepEqual(await native.store.outboxPending(), []);
      const sourceReceipt = readReceiptRow((await query(RECEIPT_MODEL))[0]!);
      assert.equal(sourceReceipt.receipt.status, 'skipped'); assert.equal(sourceReceipt.receipt.result, null); assert.equal(sourceReceipt.receipt.error, null);
      assert.equal(sourceReceipt.filePayloadOrigin?.origin.kind, 'delivery-skipped'); assert.deepEqual(sourceReceipt.filePayloadOrigin?.files, []);
      assert.equal((await query(RECEIPT_ASSOCIATION_MODEL)).length, 1);
      const savedSource = await native.store.readReceipt(receiptIdentity(falseSource)); assert.ok(savedSource); assert.ok(readScenarioReceiptAssociation(savedSource));
      const sourceCommitted = await snapshot(db); await invoke(falseSource); assert.deepEqual(await snapshot(db), sourceCommitted);
      assert.deepEqual(fileState(), filesBefore); assert.deepEqual(await snapshot(identityDb), identitiesBefore);
      entry = (await query(MODEL))[0]!;
      const rejectedEnvelope = envelope(true, false), beforeRejected = await snapshot(db), rejected = await invoke(rejectedEnvelope);
      assert.ok('error' in rejected, JSON.stringify(rejected)); assert.equal(rejected.error.code, 'rule_failed');
      assert.deepEqual(await query(WORK_DISPATCH_MODEL), []); assert.deepEqual(await native.store.outboxPending(), []);
      assert.equal((await query(RECEIPT_MODEL)).length, 1); assert.equal((await query(RECEIPT_ASSOCIATION_MODEL)).length, 1);
      const rejectedReplay = await snapshot(db); await invoke(rejectedEnvelope); assert.deepEqual(await snapshot(db), rejectedReplay);
      for (const name of Object.keys(beforeRejected)) if (!['receipts', 'fence', 'fence_log'].includes(name))
        assert.deepEqual(rejectedReplay[name], beforeRejected[name], `rejected SEND leaves ${name} unchanged`);
      let sends = 0, mints = 0;
      const binding: ProviderBinding = {deployment: textGeneration ? 'deployment.llm' : 'deployment.mail',
        capability: textGeneration ? 'std.TextGenerationV1' : 'std.EmailV1', capabilityVersion: 1, account: 'local-control'};
      const installed: InstalledMailSender = {binding, mail: {send: async (_request, options) => {
        if (userMail) {
          assert.equal(_request.to, subject.email);
          const pinned = await native.store.load(asModel(WORK_DISPATCH_MODEL), asId(options.deliveryId)); assert.ok(pinned);
          assert.equal(pinned.data['mailRecipientEmail'], subject.email);
          assert.equal(pinned.data['mailRecipientUser'], subject.user_id);
        }
        sends++; return {delivery_id: options.deliveryId, status: 'succeeded', result: {reference: 'accepted'}, error: null};
      }, reconcile: async () => { throw new Error('No recovery transport is part of this control.'); }}};
      // This synthetic installation exercises the genuine bound Text adapter and
      // durable progress fences without opening a transport or invoking a model.
      const installedText: InstalledTextGeneration = {binding,
        profile: {name: 'local-control', policyRevision: 'policy-1', provider: 'synthetic-control', model: 'synthetic-control',
          maxInputTokens: 1024, maxOutputTokens: 128, maxDurationMs: 30000, inputTokenization: 'deployment', attachments: 'unsupported'},
        text: {
          generate: async () => {throw new Error('This control requires the installed stream entry.');},
          reconcile: async () => {throw new Error('No recovery transport is part of this control.');},
          generateStream: (request, options) => {
            sends++;
            assert.equal(request.profile, 'local-control'); assert.equal(request.policy_revision, 'policy-1');
            assert.equal(request.revision, 1); assert.ok(request.source);
            assert.deepEqual(request.messages, [{role: 'user', content: 'Frozen original lexical values', attachments: []}]);
            assert.equal(request.max_input_tokens, 1024); assert.equal(request.max_output_tokens, 128);
            assert.equal(request.max_duration, 30000n);
            const terminal: ModelRunSnapshot = {sequence: 0, state: 'succeeded', content: 'Synthetic guarded reply'};
            options.onSnapshot?.(terminal);
            const completion: CapabilityCompletion<ModelChatReply> = {delivery_id: options.deliveryId, status: 'succeeded',
              result: {content: terminal.content, model: 'synthetic-control', finish: 'stop', inputTokens: 4, outputTokens: 3}, error: null};
            const done = Promise.resolve(completion);
            return {deliveryId: options.deliveryId, cancelRequested: false, snapshots: () => [terminal], done: () => done,
              cancel: async () => {throw new Error('No cancellation is part of this control.');}};
          },
        }};
      const dispatchOptions = {store: native.store, workCommands: WORK_SYSTEM_COMMANDS,
        stageCommands: WORK_DISPATCH_STAGE_COMMANDS, createClaimCommand: createWorkDispatchClaimCommand};
      const dispatcher = textGeneration
        ? await createBoundTextGenerationDispatcher({...dispatchOptions, adapter: createBoundTextGenerationAdapter({
          appDefinition: definition, binding, resolveInstalledTextGeneration: deployment => {
            assert.equal(deployment, binding.deployment); return installedText;
          }})})
        : await createBoundMailDispatcher({...dispatchOptions,
          adapter: createBoundMailAdapter({appDefinition: definition, binding, resolveInstalledMailSender: () => installed,
            ...(userMail ? {userRecipients: {teamId: team.team_id,
              findMembership: identities.findMembership.bind(identities), findUserById: identities.findUserById.bind(identities)}} : {})})});
      const drive = async (intentId: string) => {
        const retained = await native.store.outboxGet(intentId); assert.ok(retained);
        return dispatcher.drive({intentId, actor: owner.user_id, operation: 'native.Email.drive', nowMs: clock.nowMs,
          nextClaimId: () => {mints++; return `claim-${++sequence}`;}, maxClaimAgeMs: 60000,
          claimOperationId: nextId(), recordOperationId: nextId(), classifyFailure,
          evaluateGuard: () => {throw new Error('Original native guard cannot fall back to the legacy postclaim evaluator.');},
          readStateSnapshot: () => null, fence: fenceFor(retained.intent)});
      };
      const queue = async () => {
        entry = (await query(MODEL))[0]!; const input = envelope(true), accepted = await invoke(input);
        assert.ok('result' in accepted, JSON.stringify(accepted)); assert.equal(accepted.result.status, 'committed');
        const pending = await native.store.outboxPending(); assert.equal(pending.length, 1);
        const retained = await native.store.outboxGet(pending[0]!.intentId); assert.ok(retained); return {input, retained};
      };
      const original = await queue(), dispatchBefore = await native.store.load(asModel(WORK_DISPATCH_MODEL), asId(original.retained.intent.intentId));
      assert.ok(dispatchBefore); const dispatch = readDispatchRow(dispatchBefore); assert.ok(dispatch.sourceGuard); assert.ok(dispatch.filePayloadOrigin);
      assert.equal(original.retained.intent.target, textGeneration ? 'std.TextGenerationV1.generate' : mailTarget);
      for (const target of textGeneration ? ['std.EmailV1.send', 'std.TextGenerationV1.cancel'] : ['std.TextGenerationV1.generate'])
        assert.throws(() => fenceFor({...original.retained.intent, target}), /original installed guard\/owner\/binding/);
      if (modelSnapshot) {
        const frozenEntry = object(dispatch.sourceGuard.inputs['entry']);
        assert.deepEqual(Object.fromEntries(Object.entries(dispatch.sourceGuard.inputs).filter(([name]) => name !== 'entry')),
          {enabled: true, note: null, values: [], person: {id: subject.user_id}});
        // This is the original pre-set owner stage, not a ModelRef or a later live read.
        assert.equal(frozenEntry.id, entry.id); assert.equal(frozenEntry.version, entry.version);
        assert.equal(object(frozenEntry.data).count, entry.data['count']);
        assert.equal(Object.hasOwn(frozenEntry, 'parent'), true);
        assert.deepEqual(object(frozenEntry.sourcePresence).fields, Object.keys(entry.data));
        assert.equal((await query(MODEL))[0]!.data['count'], String(BigInt(entry.data['count'] as string) + 1n));
      } else assert.deepEqual(dispatch.sourceGuard.inputs, {enabled: true, note: null, values: [], person: {id: subject.user_id}});
      assert.equal(dispatch.sourceGuard.rule, guard.rule); assert.equal(dispatch.filePayloadOrigin.origin.kind, 'send-guard');
      assert.equal(dispatch.filePayloadOrigin.origin.kind === 'send-guard' && dispatch.filePayloadOrigin.origin.inputsDeclarationId, `${guard.rule}:send-inputs`);
      const pendingReceipt = await native.store.load(asModel(RECEIPT_MODEL), asId(dispatch.intentId)); assert.ok(pendingReceipt);
      const queuedReceipt = readReceiptRow(pendingReceipt); assert.equal(queuedReceipt.receipt.status, 'pending');
      assert.equal(queuedReceipt.filePayloadOrigin?.origin.kind, 'delivery-result');
      await identities.removeMembership(membership.membership_id); now += 1000;
      const beforeSkip = await snapshot(db), revision = await native.store.readRevision();
      const outcome = await drive(dispatch.intentId);
      // The genuine preclaim guard consumes/ACKs a false occurrence without
      // allocating a claim. Its public outcome is not-claimed/guard-false;
      // the canonical skipped receipt and one ACK fence are checked below.
      assert.ok(outcome.status === 'not-claimed', JSON.stringify(outcome));
      assert.equal(outcome.reason, 'guard-false');
      assert.equal(sends, 0); assert.equal(mints, 0); assert.equal(await native.store.readRevision(), revision + 1);
      const afterDispatch = await native.store.load(asModel(WORK_DISPATCH_MODEL), asId(dispatch.intentId)); assert.ok(afterDispatch);
      assert.equal(readDispatchRow(afterDispatch).guardVerdict, false); assert.equal(readDispatchRow(afterDispatch).attempts, 0);
      assert.deepEqual(readDispatchRow(afterDispatch).sourceGuard, dispatch.sourceGuard); assert.deepEqual(readDispatchRow(afterDispatch).filePayloadOrigin, dispatch.filePayloadOrigin);
      const skippedReceipt = readReceiptRow((await native.store.load(asModel(RECEIPT_MODEL), asId(dispatch.intentId)))!);
      assert.equal(skippedReceipt.receipt.status, 'skipped'); assert.equal(skippedReceipt.receipt.result, null); assert.equal(skippedReceipt.receipt.error, null);
      assert.deepEqual(skippedReceipt.filePayloadOrigin, queuedReceipt.filePayloadOrigin);
      const currentAssociation = (await query(RECEIPT_ASSOCIATION_MODEL)).map(readAssociationRow).find(value => value.deliveryId === dispatch.intentId);
      assert.ok(currentAssociation); assert.equal(currentAssociation.revision, revision + 1);
      const acknowledged = await native.store.outboxGet(dispatch.intentId); assert.ok(acknowledged);
      assert.equal(acknowledged.status, 'dispatched'); assert.deepEqual(acknowledged.intent, original.retained.intent); assert.deepEqual(acknowledged.originalCommit, original.retained.originalCommit);
      const afterSkip = await snapshot(db); assert.equal(afterSkip.fence_log!.length, beforeSkip.fence_log!.length + 1);
      await invoke(original.input); assert.deepEqual(await snapshot(db), afterSkip, 'source replay cannot stage a second original SEND');
      assert.deepEqual(await native.store.outboxPending(), []); assert.deepEqual(fileState(), filesBefore);
      entry = (await query(MODEL))[0]!;
      const negativeSource = envelope(true), priorWork = await query(WORK_DISPATCH_MODEL), negative = await invoke(negativeSource);
      assert.ok('result' in negative, JSON.stringify(negative)); assert.equal(negative.result.status, 'committed');
      assert.deepEqual(await query(WORK_DISPATCH_MODEL), priorWork); assert.deepEqual(await native.store.outboxPending(), []);
      const negativeReceipt = (await query(RECEIPT_MODEL)).map(row => readReceiptRow(row)).find(value =>
        value.filePayloadOrigin?.origin.kind === 'delivery-skipped' && value.filePayloadOrigin.origin.send.operationId === negativeSource.operation_id);
      assert.ok(negativeReceipt); assert.equal(negativeReceipt.receipt.status, 'skipped'); assert.equal(sends, 0); assert.equal(mints, 0);
      // Genuine current membership changes between observation and State commit must roll back the entire claim fence.
      await identities.reactivateMembership(membership.membership_id, {is_owner: false, roles: []});
      const racing = await queue(), held = gate(), find = identities.findMembership;
      let gated = false;
      identities.findMembership = async (teamId, userId) => {
        const observed = await find.call(identities, teamId, userId);
        if (!gated && userId === subject.user_id) {gated = true; held.begin(); await held.released;}
        return observed;
      };
      const beforeRace = await snapshot(db), raced = drive(racing.retained.intent.intentId);
      await held.started; await identities.removeMembership(membership.membership_id); held.release();
      await assert.rejects(raced); identities.findMembership = find;
      assert.deepEqual(await snapshot(db), beforeRace); assert.equal(sends, 0); assert.equal(mints, 1);
      // A fresh retry observes the negative membership and skips with no additional mint/provider.
      await drive(racing.retained.intent.intentId); assert.equal(sends, 0); assert.equal(mints, 1);
      await identities.reactivateMembership(membership.membership_id, {is_owner: false, roles: []});
      if (references) {
        // Revoke during the LAST physical reference recheck, after the source
        // predicate observed membership. State must recheck that subject after
        // these new awaits, keeping the actual Work claim fence unpublished.
        const lateReference = await queue(), load = native.store.cohortLoad;
        let profileReads = 0, revoked = false;
        native.store.cohortLoad = async input => {
          const row = await load.call(native.store, input);
          if (input.model === profileModel && ++profileReads === 3) {
            await identities.removeMembership(membership.membership_id); revoked = true;
          }
          return row;
        };
        const beforeReferenceRace = await snapshot(db);
        try { await assert.rejects(drive(lateReference.retained.intent.intentId)); }
        finally { native.store.cohortLoad = load; }
        assert.equal(revoked, true, 'the current target read actually races subject revocation');
        assert.deepEqual(await snapshot(db), beforeReferenceRace);
        assert.equal(sends, 0); assert.equal(mints, 2);
        await drive(lateReference.retained.intent.intentId);
        assert.equal(sends, 0); assert.equal(mints, 2);
        await identities.reactivateMembership(membership.membership_id, {is_owner: false, roles: []});
        const guarded = await queue();
        const currentProfile = (await query(profileModel))[0]!;
        const disabled = await invoke({operation: `${profileModel}.update`, operation_id: nextId(),
          inputs: {record: {id: currentProfile.id, version: String(currentProfile.version)}, active: false}});
        assert.ok('result' in disabled, JSON.stringify(disabled));
        const refused = await drive(guarded.retained.intent.intentId);
        assert.equal(refused.status, 'not-claimed');
        if (refused.status === 'not-claimed') assert.equal(refused.reason, 'guard-false');
        assert.equal(sends, 0); assert.equal(mints, 2, 'current parent/reference refusal does not mint a claim');
        const inactive = (await query(profileModel))[0]!;
        const enabled = await invoke({operation: `${profileModel}.update`, operation_id: nextId(),
          inputs: {record: {id: inactive.id, version: String(inactive.version)}, active: true}});
        assert.ok('result' in enabled, JSON.stringify(enabled));
      }
      const positive = await queue();
      if (modelSnapshot) {
        const live = (await query(MODEL))[0]!;
        const changed = await invoke({operation: `${MODEL}.update`, operation_id: nextId(),
          inputs: {record: {id: live.id, version: String(live.version)}, count: '-1'}});
        assert.ok('result' in changed, JSON.stringify(changed)); assert.equal(changed.result.status, 'committed');
        assert.equal((await query(MODEL))[0]!.data['count'], '-1');
      }
      assert.equal((await drive(positive.retained.intent.intentId)).status, 'recorded');
      assert.equal(sends, 1); assert.equal(mints, references ? 3 : 2);
      const deliveredReceipt = readReceiptRow((await native.store.load(asModel(RECEIPT_MODEL), asId(positive.retained.intent.intentId)))!).receipt;
      assert.equal(deliveredReceipt.status, 'succeeded');
      if (textGeneration) {
        const result = object(deliveredReceipt.result);
        assert.equal(result.source, positive.input.operation_id); assert.equal(result.revision, '1');
        assert.equal(result.state, 'succeeded'); assert.equal(result.content, 'Synthetic guarded reply');
        assert.equal(result.used_tokens, '7');
      }
      const terminal = await snapshot(db); await drive(positive.retained.intent.intentId); assert.deepEqual(await snapshot(db), terminal); assert.equal(sends, 1);
      await invoke(positive.input); assert.deepEqual(await snapshot(db), terminal); assert.equal(sends, 1); assert.equal(mints, references ? 3 : 2);
      assert.throws(() => fenceFor({...positive.retained.intent, occurrenceIndex: positive.retained.intent.occurrenceIndex + 1, dispatchGuard: 'foreign'}));
      const plain = await invoke({operation: `${APP}.plain`, operation_id: nextId(), inputs: {}}); assert.ok('result' in plain, JSON.stringify(plain));
      const legacy = (await native.store.outboxPending())[0]!; assert.equal(legacy.dispatchGuard, undefined);
      assert.equal(readDispatchRow((await native.store.load(asModel(WORK_DISPATCH_MODEL), asId(legacy.intentId)))!).sourceGuard, undefined);
      assert.equal(JSON.stringify(artifact), originalArtifact); assert.deepEqual(fileState(), filesBefore);
      assert.deepEqual(await Promise.all(paths.map(async path => hash(await readFile(path)))), originals.map(hash), 'actual consumed source/compiler/catalog stay unchanged');
    } finally {physical?.close(); await worker?.dispose(); await rm(dir, {recursive: true, force: true});}
  });
