/** Declaration-labelled Dev receiving component; not Compiler/native source acceptance.
 * Reuses the released State prefix declaration and the existing scenario-file
 * component's actual assembly/Identity/Memory-State/SQLite-Files setup. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants } from 'node:vm';
import { test } from 'vitest';
import type { CanTypeId, CompileArtifact, ModelName, OperationId, Receipt, StoredRow } from '@canlang/contracts';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const require = createRequire(import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const producer = (specifier: string) => pathToFileURL(require.resolve(specifier)).href;
const APP = 'PrefixFiles', CONVERSATION = 'PrefixFiles.Conversation' as ModelName,
  BRANCH = 'PrefixFiles.Branch' as ModelName, OP = 'PrefixFiles.countPrefix';
const TYPE = 'std.TextMessage[]' as CanTypeId, source = 'prefix-files-component.can', modulePath = 'prefix-files.mjs';
const sourceText = '## Declaration-labelled whole-prefix receiving component; no compiled Can claim.';
const sha256 = createHash('sha256').update(sourceText).digest('hex');
const origin = { path: source, sha256, module: modulePath };
const retention = { unattachedHorizonMs: 60_000, retentionMs: 120_000 };
let sequence = 119_000;
function artifact(): CompileArtifact {
  // Literal same declaration as the released owning prefix control; this test
  // does not issue a File profile or construct a physical observation itself.
  const valueTypes = { contracts: [{ name: 'std.TextMessage', fields: [
    { name: 'role', type: 'enum(system,user,assistant)' as CanTypeId },
    { name: 'content', type: 'text' as CanTypeId }, { name: 'attachments', type: 'file[]' as CanTypeId },
  ] }] };
  const policy = { operations: { [OP]: { by: ['members'] } }, models: {
    [CONVERSATION]: { read: ['Conversation.read.1'] }, [BRANCH]: { read: ['Branch.read.1'] },
  } };
  const definition = { id: APP, policy, contracts: { 'std.TextMessage': { fields: {
    role: { type: 'enum(system,user,assistant)' }, content: { type: 'text' }, attachments: { type: 'file[]' },
  } } }, models: {
    [CONVERSATION]: { fields: { title: { type: 'text' } },
      readGrants: [{ rule: 'Conversation.read.1', by: ['members'], fields: ['title'] }] },
    [BRANCH]: { fields: { prefix: { type: TYPE }, state: { type: 'text' } },
      readGrants: [{ rule: 'Branch.read.1', by: ['members'], fields: ['prefix', 'state'] }] },
  } };
  const js = `import {count,encodeValue,set,hasRole,observeScenarioReceiptDependency,selectScenarioReceiptReturn} from '@canlang/stdlib';
let executions=0;const snapshots=[];
export const executionCount=()=>executions;export const prefixSnapshots=()=>snapshots;
export const appDefinition=${JSON.stringify(definition)};
export function canApp(){return {policy:appDefinition.policy,read:{'Conversation.read.1':c=>hasRole(c,'members'),'Branch.read.1':c=>hasRole(c,'members')},PrefixFiles:{
countPrefix:async(c,input)=>{executions++;
 const prefix=input.branch.prefix;
 await observeScenarioReceiptDependency(c,${JSON.stringify(BRANCH)},input.branch,'prefix','prefix');
 snapshots.push(encodeValue(${JSON.stringify(TYPE)},prefix));
 await set(c,input.branch,{state:'counted'});
 selectScenarioReceiptReturn(c,'count');return count(prefix);
}}};}`;
  return { artifact_version: 1, language_version: 'declaration-labelled component', tool_version: 'consumer fixture',
    sources: [{ path: source, sha256 }], modules: [{ path: modulePath, js,
      map: { version: 3, file: modulePath, sources: [source], sourcesContent: [sourceText], names: [], mappings: '' } }],
    requires: [{ capability: 'canlang.builtins', min_version: 2 }, { capability: 'state', min_version: 1 },
      { capability: 'state.parameters', min_version: 1 }], pages: [], tests: [], valueTypes,
    models: [{ name: CONVERSATION, deleteMode: 'archive', fields: [
      { name: 'title', field: { kind: 'string' }, required: true, serverOnly: false },
    ] }, { name: BRANCH, parent: CONVERSATION, deleteMode: 'archive', fields: [
      { name: 'prefix', field: { kind: 'nominal', name: 'std.TextMessage' }, valueType: TYPE,
        array: { required: false }, max: 120, required: false, serverOnly: false },
      { name: 'state', field: { kind: 'string' }, required: true, serverOnly: false },
    ] }], operations: [
      ...[CONVERSATION, BRANCH].map(model => ({ name: `${model}.read`, kind: 'read' as const,
        description: '', inputs: { fields: [] } })),
      { name: OP, kind: 'scenario', description: '', inputs: { fields: [
      { name: 'branch', field: { kind: 'ref', model: BRANCH, requireVersion: true }, required: true },
    ] }, result: { type: 'int' as CanTypeId, disclosure: { version: 1, source: origin,
      returns: [{ id: 'count', source: origin, influences: [], dependencies: [
        { id: 'prefix', source: origin, role: 'data', model: BRANCH, field: 'prefix', type: TYPE },
      ] }] } } }], callables: [{ id: OP, kind: 'operation', module: modulePath, export: 'countPrefix',
      member: ['PrefixFiles', 'countPrefix'], inputStyle: 'parameters' }],
  };
}
function hold() {
  let begin!: () => void, release!: () => void;
  const started = new Promise<void>(done => { begin = done; }), released = new Promise<void>(done => { release = done; });
  return { started, begin, released, release };
}
async function world(options: { empty?: boolean; malformed?: boolean; missingFiles?: boolean; pause?: ReturnType<typeof hold> } = {}) {
  // One genuine installed loader for every issuer/assembler/consumer WeakMap.
  const { assembleModules, importVerifiedAssemblyModule } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
  const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
  const { createCanonicalFileBinding } = await nodeImport(installed('runtime/bound-files.js')) as typeof import('../src/runtime/bound-files.js');
  const { DEFAULT_FILE_POLICY, blobKeyForFile, ingestVerifiedEventBytes } = await nodeImport(producer('@canlang/files')) as typeof import('@canlang/files');
  const { createSqliteFileBindings, createSqliteFileStore } = await nodeImport(producer('@canlang/files/host/sqlite')) as typeof import('@canlang/files/host/sqlite');
  const { createFileJourneyKernel } = await nodeImport(producer('@canlang/interfaces/uploads/kernel')) as typeof import('@canlang/interfaces/uploads/kernel');
  const { createFrozenClock, createMemoryIdentityStore } = await nodeImport(producer('@canlang/identity/testing')) as typeof import('@canlang/identity/testing');
  const { resolveIdentity, sha256HexText } = await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
  const { readScenarioReceiptAssociation } = await nodeImport(producer('@canlang/state/invocation')) as typeof import('@canlang/state/invocation');
  const { createTestMemoryStorage } = await nodeImport(producer('@canlang/state/storage/memory')) as typeof import('@canlang/state/storage/memory');
  const { FIXED_NOW, seedRow, makeRow, makeBatch, uuidv7 } = await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
  const directory = await mkdtemp(join(tmpdir(), 'can-prefix-file-component-'));
  const physical = createSqliteFileStore(join(directory, 'files.sqlite'));
  try {
    const compiled = artifact(), originalArtifact = JSON.stringify(compiled);
    const asm = await assembleModules({ artifact: compiled, sourcePath: source }, { workDir: join(directory, 'modules'),
      stdlibUrl: installed('runtime/stdlib.js') });
    const clock = createFrozenClock(FIXED_NOW), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({});
    const user = await identities.createUser({ email: 'prefix-member@example.test', password_hash: 'unused', email_verified: true });
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = randomBytes(32).toString('hex');
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(FIXED_NOW + 86400000).toISOString(), last_team_id: team.team_id });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const receiver = { app: APP, team: team.team_id, owner: team.team_id, principal: user.user_id };
    let fileNow = FIXED_NOW;
    const fileClock = { nowMs: () => fileNow }, bytes = new TextEncoder().encode('original prefix receiving bytes\n');
    const refs = [0, 1].map(itemIndex => {
      const finalized = ingestVerifiedEventBytes({ clock: fileClock, files: physical.files, blobs: physical.blobs,
        intents: physical.intents, fileIds: { nextFileId: () => randomUUID() } }, {
        provenance: { kind: 'event', source: 'deployment.mail', adapter: 'deployment.mail', occurrenceId: randomUUID(),
          fieldPath: 'attachments', itemIndex }, receiver, claimedType: 'text/plain', bytes, policy: DEFAULT_FILE_POLICY,
      });
      assert.equal(finalized.status, 'finalized'); if (finalized.status !== 'finalized') throw new Error('Files finalization refused');
      return finalized.file.id;
    });
    const kernel = createFileJourneyKernel(createSqliteFileBindings(physical, {
      clock: fileClock, intentTtlMs: 60000, urlBase: 'https://prefix-files.invalid',
    }));
    const observedRefs: string[] = [];
    let gated = false;
    const observedKernel = { ...kernel, observeFile: async (...args: Parameters<typeof kernel.observeFile>) => {
      observedRefs.push(args[0]);
      // Delegate to the actual owning issuer. The control only pauses its
      // response, never creates/replaces facts or reimplements traversal.
      const fact = await kernel.observeFile(...args);
      if (options.pause !== undefined && !gated) { gated = true; options.pause.begin(); await options.pause.released; }
      return fact;
    } };
    const files = createCanonicalFileBinding(observedKernel, retention);
    const { store, probe } = createTestMemoryStorage();
    const parent = await seedRow(store, CONVERSATION, { id: 'conversation', data: { title: 'Original conversation' } });
    const message = (attachments: readonly string[]) => ({ role: 'user', content: 'Original message', attachments: attachments.map(id => ({ id })) });
    const prefix = options.empty ? [] : [message([refs[1]!, refs[0]!, refs[1]!]), message([])];
    if (options.malformed) {
      const malformedAttachment = { id: refs[0]!, unexpected: true };
      prefix[0]!.attachments = [malformedAttachment];
    }
    const row: StoredRow = { ...makeRow({ id: 'branch', data: { prefix, state: 'open' } }), parent: { model: CONVERSATION, id: parent.id } };
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: BRANCH, row }] }));
    const ns = await importVerifiedAssemblyModule(asm, modulePath, compiled) as {
      executionCount: () => number; prefixSnapshots: () => unknown[];
    };
    const env = { operation: OP, operation_id: uuidv7(FIXED_NOW, ++sequence), inputs: { branch: { id: row.id, version: String(row.version) } } };
    const receiptIdentity: Receipt['identity'] = { app: APP, owner: team.team_id, principal: user.user_id,
      operation: OP as Receipt['identity']['operation'], operationId: env.operation_id as OperationId };
    const snapshot = async () => ({ revision: await store.readRevision(), rows: await store.query({ model: BRANCH, authority: 'owner', archived: 'include' }),
      history: probe.historyFor(BRANCH, row.id), outbox: probe.outboxAll(), schedules: await store.schedulesDue(Number.MAX_SAFE_INTEGER, 100),
      receipt: await store.readReceipt(receiptIdentity), files: physical.files.listAll(), intents: physical.intents.listAll(),
      bytes: refs.map(ref => physical.blobs.read(blobKeyForFile(ref))) });
    const invoke = () => buildInvoker(compiled, asm, store, { appId: APP, memberships: identities, now: () => FIXED_NOW,
      ...(options.missingFiles ? {} : { files }) }).invokeMutation(env, identity);
    return { compiled, originalArtifact, refs, prefix, receiver, row, store, identities, membership, env, receiptIdentity,
      observedRefs, ns, invoke, snapshot, readScenarioReceiptAssociation,
      expire: () => { fileNow = FIXED_NOW + retention.retentionMs + 1; },
      close: async () => { options.pause?.release(); physical.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { options.pause?.release(); physical.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}

test('Dev whole-prefix getter/ordinary marker receives ordered duplicate nominal Files and explicit empty census', async () => {
  for (const empty of [false, true]) {
    const w = await world({ empty });
    try {
      const before = await w.snapshot(), result = await w.invoke();
      assert.ok('result' in result, JSON.stringify(result)); assert.equal(result.result.status, 'committed');
      assert.equal(result.result.result, empty ? '0' : '2');
      assert.equal(w.ns.executionCount(), 1); assert.deepEqual(w.ns.prefixSnapshots(), [w.prefix]);
      assert.deepEqual(w.observedRefs, empty ? [] : [w.refs[1], w.refs[0]], 'actual Dev census calls the real issuer once per distinct ref');
      const receipt = await w.store.readReceipt(w.receiptIdentity); assert.ok(receipt);
      const association = w.readScenarioReceiptAssociation(receipt); assert.ok(association);
      const observation = association.observations.find(item => item.dependencyId === 'prefix'); assert.ok(observation);
      assert.deepEqual(observation.row.data.prefix, w.prefix);
      assert.deepEqual(observation.files?.map(file => file.ref), empty ? [] : [w.refs[1], w.refs[0]]);
      for (const file of observation.files ?? []) assert.deepEqual(file.receiver, w.receiver);
      const after = await w.snapshot(); assert.equal(after.revision, before.revision + 1); assert.equal(after.history.length, 1);
      assert.deepEqual(after.rows[0]!.data, { prefix: w.prefix, state: 'counted' });
      for (const key of ['files', 'intents', 'bytes', 'outbox', 'schedules'] as const) assert.deepEqual(after[key], before[key]);
      const replay = await w.invoke();
      assert.ok('result' in replay, JSON.stringify(replay)); assert.equal(replay.result.status, 'replayed');
      assert.deepEqual(await w.snapshot(), after); assert.equal(w.ns.executionCount(), 1);
      assert.deepEqual(w.observedRefs, empty ? [] : [w.refs[1], w.refs[0]]);
      assert.equal(JSON.stringify(w.compiled), w.originalArtifact);
    } finally { await w.close(); }
  }
});

test('Dev receiving join refuses malformed whole prefix, missing Files producer and expired physical retention without business effects', async () => {
  for (const mode of ['malformed', 'missing', 'expired'] as const) {
    const w = await world({ malformed: mode === 'malformed', missingFiles: mode === 'missing' });
    try {
      if (mode === 'expired') w.expire();
      const before = await w.snapshot(), result = await w.invoke();
      assert.ok('error' in result, JSON.stringify(result)); assert.match(result.error.message,
        mode === 'expired' ? /receiving observation|File|file/i : mode === 'missing' ? /Files producer|File source|File/i : /schema validation/i);
      const after = await w.snapshot(); assert.ok(after.receipt);
      assert.deepEqual(after.receipt.identity, w.receiptIdentity);
      assert.deepEqual(after.receipt.outcome, { status: 'rejected', code: result.error.code, message: result.error.message });
      assert.equal(after.revision, before.revision + 1); assert.equal(after.receipt.committedRevision, after.revision);
      assert.deepEqual({ ...after, receipt: before.receipt, revision: before.revision }, before);
      assert.deepEqual(w.ns.prefixSnapshots(), []);
      assert.equal(JSON.stringify(w.compiled), w.originalArtifact);
    } finally { await w.close(); }
  }
});

test('Dev actual awaited Files capture cannot complete after current membership is revoked', async () => {
  const gate = hold(), w = await world({ pause: gate }); let pending: ReturnType<typeof w.invoke> | undefined;
  try {
    const before = await w.snapshot(); pending = w.invoke();
    await Promise.race([gate.started, pending.then(result => { throw new Error('Invocation ended before its actual receiving callback: ' + JSON.stringify(result)); })]);
    assert.deepEqual(w.observedRefs, [w.refs[1]]); assert.equal(w.ns.executionCount(), 1);
    await w.identities.removeMembership(w.membership.membership_id); gate.release();
    const result = await pending; pending = undefined;
    assert.ok('error' in result, JSON.stringify(result)); assert.match(result.error.message, /membership|member|authority|read|grant|forbidden/i);
    const after = await w.snapshot(); assert.ok(after.receipt);
    assert.deepEqual(after.receipt.identity, w.receiptIdentity);
    assert.deepEqual(after.receipt.outcome, { status: 'rejected', code: result.error.code, message: result.error.message });
    assert.equal(after.revision, before.revision + 1); assert.equal(after.receipt.committedRevision, after.revision);
    assert.deepEqual({ ...after, receipt: before.receipt, revision: before.revision }, before);
    assert.deepEqual(w.ns.prefixSnapshots(), []);
  } finally { gate.release(); try { await pending; } finally { await w.close(); } }
});
