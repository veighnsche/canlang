/** Declaration-labelled host component over genuine State/Identity and SQLite
 * Files. This does not qualify native Compiler File/Set source acceptance. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CanTypeId, CompileArtifact, FinalizedFileObservation, ModelName,
  OperationId, ProjectedRecord, Receipt, StoragePort } from '@canlang/contracts';
import { DEFAULT_FILE_POLICY, blobKeyForFile, ingestVerifiedEventBytes,
  readFinalizedFileObservation } from '@canlang/files';
import { createSqliteFileBindings, createSqliteFileStore } from '@canlang/files/host/sqlite';
import { createFileJourneyKernel } from '@canlang/interfaces/uploads/kernel';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { readScenarioReceiptAssociation } from '@canlang/state/invocation';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { FIXED_NOW, seedRow, updateRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { buildInvoker } from '@canlang/cloudflare/worker/assembly';
import { createCanonicalFileBinding } from '@canlang/cloudflare/runtime/bound-files';
import { assembleModules, importVerifiedAssemblyModule } from '@canlang/cloudflare/runtime/modules';

const app = 'ScenarioFiles', model = 'ScenarioFiles.Record' as ModelName;
const source = 'scenario-file-component.can', modulePath = 'scenario-files.mjs';
const sourceText = '## Declaration-labelled File assignment and independent literal text result.';
const sha256 = createHash('sha256').update(sourceText).digest('hex');
const origin = { path: source, sha256, module: modulePath };
const retention = { unattachedHorizonMs: 3 * 86400000, retentionMs: 3 * 86400000 };
const bytes = new TextEncoder().encode('genuine SQLite finalized bytes\n');
let sequence = 65000;
type Field = 'file' | 'optionalFile' | 'files';
const shapes = {
  file: { field: { kind: 'file' as const }, valueType: 'file' as CanTypeId },
  optionalFile: { field: { kind: 'file' as const }, valueType: 'file?' as CanTypeId, nullable: true },
  files: { field: { kind: 'file' as const }, valueType: 'file[]' as CanTypeId, array: { required: false }, max: 4 },
};
function artifact(): CompileArtifact {
  const operations = (Object.keys(shapes) as Field[]).map(field => ({
    name: `${app}.${field}`, kind: 'scenario' as const, description: '', inputs: { fields: [
      { name: 'record', field: { kind: 'ref' as const, model, requireVersion: true }, required: true },
      { name: 'value', ...shapes[field], required: true },
    ] }, result: { type: 'text' as CanTypeId, disclosure: { version: 1 as const, source: origin,
      returns: [{ id: 'selected', source: origin, dependencies: [], influences: [] }] } },
  }));
  operations.push({ name: `${app}.rename`, kind: 'scenario', description: '', inputs: { fields: [
    { name: 'record', field: { kind: 'ref', model, requireVersion: true }, required: true },
  ] }, result: operations[0]!.result });
  const policy = { operations: Object.fromEntries(operations.map(op => [op.name, { by: ['members'] }])),
    models: { [model]: { read: ['Record.read.1'] } } };
  const js = `import {set,selectScenarioReceiptReturn} from '@canlang/stdlib';
let executions=0; export const executionCount=()=>executions;
export const appDefinition=${JSON.stringify({ id: app, policy, models: { [model]: {
    fields: { visible: { type: 'text' }, file: { type: 'file' }, optionalFile: { type: 'file?' }, files: { type: 'file[]' } },
    readGrants: [{ rule: 'Record.read.1', by: ['members'], fields: ['visible', 'file', 'optionalFile', 'files'] }],
  } } })};
export function canApp(){return {policy:appDefinition.policy,read:{'Record.read.1':()=>true},ScenarioFiles:{
${(Object.keys(shapes) as Field[]).map(field => `${field}:async(c,input)=>{
 executions++; await set(c,input.record,{${field}:input.value,visible:'assigned visible'});
 selectScenarioReceiptReturn(c,'selected'); return 'updated';}`).join(',\n')},
rename:async(c,input)=>{executions++;await set(c,input.record,{visible:'renamed visible'});
 selectScenarioReceiptReturn(c,'selected');return 'updated';}
}};}`;
  return { artifact_version: 1, language_version: 'declaration-labelled component', tool_version: 'consumer fixture',
    sources: [{ path: source, sha256 }], modules: [{ path: modulePath, js,
      map: { version: 3, file: modulePath, sources: [source], sourcesContent: [sourceText], names: [], mappings: '' } }],
    requires: [{ capability: 'canlang.builtins', min_version: 2 }, { capability: 'state', min_version: 1 },
      { capability: 'state.parameters', min_version: 1 }], pages: [], tests: [], operations,
    callables: operations.map(op => ({ id: op.name, kind: 'operation' as const, module: modulePath,
      export: op.name.split('.').at(-1)!, member: op.name.split('.'), inputStyle: 'parameters' as const })),
    models: [{ name: model, deleteMode: 'archive', fields: [
      { name: 'visible', field: { kind: 'string' }, required: false, serverOnly: false },
      ...(Object.keys(shapes) as Field[]).map(field => ({ name: field, ...shapes[field], required: false, serverOnly: false })),
    ] }],
  };
}
function records(result: { readonly records?: readonly unknown[] }): readonly ProjectedRecord[] {
  assert.ok(Array.isArray(result.records));
  return result.records as readonly ProjectedRecord[];
}
async function world(copiedObservation = false, interruptRetention = false, swapRevalidator = false) {
  const dir = await mkdtemp(join(tmpdir(), 'can-scenario-files-'));
  const physical = createSqliteFileStore(join(dir, 'files.sqlite'));
  try {
    const compiled = artifact(), require = createRequire(import.meta.url);
    const asm = await assembleModules({ artifact: compiled, sourcePath: source }, { workDir: join(dir, 'modules'),
      stdlibUrl: pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href });
    const clock = createFrozenClock(FIXED_NOW), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({});
    const user = await identities.createUser({ email: 'member@scenario-files.test', password_hash: 'unused', email_verified: true });
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = randomBytes(32).toString('hex');
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(FIXED_NOW + 4 * 86400000).toISOString(), last_team_id: team.team_id });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const receiver = { app, team: team.team_id, owner: team.team_id, principal: user.user_id };
    let now = FIXED_NOW, observations = 0;
    const fileClock = { nowMs: () => now };
    const refs = [0, 1].map(itemIndex => {
      const result = ingestVerifiedEventBytes({ clock: fileClock, files: physical.files, blobs: physical.blobs,
        intents: physical.intents, fileIds: { nextFileId: () => randomUUID() } }, {
        provenance: { kind: 'event', source: 'deployment.mail', adapter: 'deployment.mail', occurrenceId: randomUUID(),
          fieldPath: 'attachments', itemIndex }, receiver, claimedType: 'text/plain', bytes, policy: DEFAULT_FILE_POLICY,
      });
      assert.equal(result.status, 'finalized');
      if (result.status !== 'finalized') throw new Error('actual Files finalization refused');
      return result.file.id;
    });
    const kernel = createFileJourneyKernel(createSqliteFileBindings(physical, {
      clock: fileClock, intentTtlMs: 60000, urlBase: 'https://scenario-files.invalid',
    }));
    const genuineObserve = kernel.observeFile;
    let substituteRevalidations = 0;
    const observedKernel = { ...kernel, observeFile: async (...args: Parameters<typeof genuineObserve>) => {
      observations++;
      const observation = await genuineObserve(...args);
      assert.ok(observation); assert.ok(readFinalizedFileObservation(observation));
      if (swapRevalidator) files.revalidate = async () => { substituteRevalidations++; return true; };
      if (!copiedObservation) return observation;
      const copied = { ...observation };
      assert.equal(readFinalizedFileObservation(copied), null);
      return copied as FinalizedFileObservation; // Deliberately forged negative input, never positive authority.
    } };
    const genuineBinding = createCanonicalFileBinding(observedKernel, retention);
    let retentions = 0, failAfterRetention = interruptRetention;
    const files = { ...genuineBinding, retain: async (...args: Parameters<typeof genuineBinding.retain>) => {
      retentions++; await genuineBinding.retain(...args);
      if (failAfterRetention) { failAfterRetention = false; throw new Error('lost postcommit attachment response'); }
    } };
    const { store, probe } = createTestMemoryStorage();
    const row = await seedRow(store, model, { data: { visible: 'original visible' } });
    const ns = await importVerifiedAssemblyModule(asm, modulePath, compiled);
    assert.ok(typeof ns === 'object' && ns !== null && 'executionCount' in ns && typeof ns.executionCount === 'function');
    const executionCount = ns.executionCount as () => number;
    let attemptedCommits = 0;
    const readonlyStore: StoragePort = { ...store, commit: async () => { attemptedCommits++; throw new Error('saved recovery commit tripwire'); } };
    const invoker = (replay = false, aged = false) => buildInvoker(compiled, asm, replay ? readonlyStore : store,
      { appId: app, memberships: identities, now: () => FIXED_NOW + (aged ? 16 * 60000 : 0), files });
    const envelope = (field: Field, value: unknown, current = row) => ({ operation: `${app}.${field}`,
      operation_id: uuidv7(FIXED_NOW, ++sequence), inputs: { record: { id: current.id, version: String(current.version) }, value } });
    const receiptIdentity = (env: Pick<ReturnType<typeof envelope>, 'operation' | 'operation_id'>): Receipt['identity'] => ({ app, owner: team.team_id,
      principal: user.user_id, operation: env.operation as Receipt['identity']['operation'], operationId: env.operation_id as OperationId });
    const snapshot = async (env: Pick<ReturnType<typeof envelope>, 'operation' | 'operation_id'>) => ({ revision: await store.readRevision(),
      rows: await store.query({ model, authority: 'owner', archived: 'include' }), history: probe.historyFor(model, row.id),
      outbox: probe.outboxAll(), schedules: await store.schedulesDue(Number.MAX_SAFE_INTEGER, 100),
      receipt: await store.readReceipt(receiptIdentity(env)), files: physical.files.listAll(), intents: physical.intents.listAll(),
      bytes: refs.map(ref => physical.blobs.read(blobKeyForFile(ref))),
      membership: await identities.findMembership(team.team_id, user.user_id),
    });
    return { compiled, asm, physical, refs, receiver, files, store, row, identities, identity, membership, envelope,
      invoker, receiptIdentity, snapshot, counters: () => ({ executions: executionCount(), attemptedCommits, observations }),
      retentions: () => retentions,
      substituteRevalidations: () => substituteRevalidations,
      setNow: (value: number) => { now = value; },
      close: async () => { physical.close(); await rm(dir, { recursive: true, force: true }); } };
  } catch (error) { physical.close(); await rm(dir, { recursive: true, force: true }); throw error; }
}
type World = Awaited<ReturnType<typeof world>>;
async function fresh(w: World, field: Field, value: unknown) {
  const envelope = w.envelope(field, value), outcome = await w.invoker().invokeMutation(envelope, w.identity);
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, 'committed'); assert.equal(outcome.result.result, 'updated');
  const receipt = await w.store.readReceipt(w.receiptIdentity(envelope)); assert.ok(receipt);
  const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
  const current = await w.store.load(model, w.row.id); assert.ok(current);
  assert.equal(current.version, w.row.version + 1);
  assert.deepEqual(current.data[field], value);
  assert.deepEqual(association.changed[0]!.row, current);
  assert.equal(association.changed[0]!.fieldTypes[field], shapes[field].valueType);
  assert.deepEqual(records(outcome.result)[0]!.data[field], value);
  assert.equal(JSON.stringify(outcome).includes('fileAssignments'), false);
  return { envelope, receipt, association, current };
}
async function replay(w: World, env: ReturnType<World['envelope']>, aged = false) {
  const before = await w.snapshot(env), counters = w.counters();
  const outcome = aged ? await w.invoker(true, true).invokeRetainedMutation(env, w.identity)
    : await w.invoker(true).invokeMutation(env, w.identity);
  assert.ok('result' in outcome, JSON.stringify(outcome)); assert.equal(outcome.result.status, 'replayed');
  assert.equal(outcome.result.result, 'updated');
  assert.deepEqual(await w.snapshot(env), before);
  assert.deepEqual(w.counters(), counters, 'recovery executes no body, observes no new Files and commits nothing');
  return outcome.result;
}

test('canonical checked File assignments retain real scalar, nullable and ordered-array observations through ordinary and aged recovery', async () => {
  for (const [field, mode] of [['file', 'value'], ['optionalFile', 'value'], ['optionalFile', 'null'],
    ['files', 'value'], ['files', 'empty']] as const) {
    const w = await world();
    try {
      const value = mode === 'null' ? null : mode === 'empty' ? [] : field === 'files'
        ? [{ id: w.refs[1] }, { id: w.refs[0] }, { id: w.refs[1] }] : { id: w.refs[0] };
      const { envelope, association } = await fresh(w, field, value);
      const expected = mode !== 'value' ? [] : field === 'files' ? [w.refs[1], w.refs[0]] : [w.refs[0]];
      assert.deepEqual(association.fileAssignments!.map(item => item.file.ref), expected);
      for (const item of association.fileAssignments!) {
        assert.deepEqual({ model: item.model, recordId: item.recordId, field: item.field }, { model, recordId: w.row.id, field });
        assert.equal(item.rowVersion, w.row.version + 1); assert.deepEqual(item.file.receiver, w.receiver);
        assert.equal(item.file.sizeBytes, bytes.byteLength);
        assert.equal(item.file.bytesDigest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
      }
      assert.equal(w.counters().executions, 1);
      for (const aged of [false, true]) assert.deepEqual(records(await replay(w, envelope, aged))[0]!.data[field], value);
    } finally { await w.close(); }
  }
});

test('a copied genuine opaque File observation refuses and poisons the canonical capture without domain or Files effects', async () => {
  const w = await world(true);
  try {
    const env = w.envelope('file', { id: w.refs[0] }), before = await w.snapshot(env);
    const denied = await w.invoker().invokeMutation(env, w.identity);
    assert.ok('error' in denied, JSON.stringify(denied));
    const after = await w.snapshot(env);
    assert.deepEqual(after.rows, before.rows); assert.deepEqual(after.history, before.history);
    assert.deepEqual(after.outbox, before.outbox); assert.deepEqual(after.schedules, before.schedules);
    assert.deepEqual(after.files, before.files); assert.deepEqual(after.bytes, before.bytes);
    assert.equal(w.counters().observations, 1); assert.equal(w.counters().executions, 1);
    if (after.receipt !== null) assert.equal(after.receipt.outcome.status, 'rejected');
  } finally { await w.close(); }
});

test('an awaited genuine observation cannot replace the originally pinned host File revalidator', async () => {
  const w = await world(false, false, true);
  try {
    const env = w.envelope('file', { id: w.refs[0] }), before = await w.snapshot(env);
    let commits = 0;
    const store: StoragePort = { ...w.store, commit: async batch => { commits++; return w.store.commit(batch); } };
    const invoker = buildInvoker(w.compiled, w.asm, store, { appId: app, memberships: w.identities,
      now: () => FIXED_NOW, files: w.files });
    const denied = await invoker.invokeMutation(env, w.identity);
    assert.ok('error' in denied, JSON.stringify(denied));
    assert.equal(w.substituteRevalidations(), 0, 'an accepting replacement is never selected after observation awaits');
    assert.equal(commits, 0); assert.deepEqual(await w.snapshot(env), before);
    assert.equal(w.retentions(), 0); assert.equal(w.counters().observations, 1); assert.equal(w.counters().executions, 1);
  } finally { await w.close(); }
});

test('ordinary saved replay repairs a genuine lost attachment response while retained-only recovery performs no attachment repair', async () => {
  const w = await world(false, true);
  try {
    const env = w.envelope('file', { id: w.refs[0] });
    const interrupted = await w.invoker().invokeMutation(env, w.identity);
    assert.ok('error' in interrupted, JSON.stringify(interrupted));
    const receipt = await w.store.readReceipt(w.receiptIdentity(env)); assert.ok(receipt);
    assert.equal(receipt.outcome.status, 'committed');
    const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
    assert.equal(association.fileAssignments!.length, 1);
    const locator = `${model}/${w.row.id}/file`;
    assert.equal(w.physical.files.get(w.refs[0]!)?.attachedRecord, locator);
    assert.equal(w.retentions(), 1); assert.equal(w.counters().executions, 1);
    await replay(w, env, true);
    assert.equal(w.retentions(), 1, 'dedicated recovery never retries attachment metadata');
    await replay(w, env);
    assert.equal(w.retentions(), 2, 'ordinary replay retries the actual retained locator/ref');
    assert.equal(w.physical.files.get(w.refs[0]!)?.attachedRecord, locator);
    assert.deepEqual(await w.store.readReceipt(w.receiptIdentity(env)), receipt);
  } finally { await w.close(); }
});

test('saved File projection rechecks current wire, receiver, bytes, retention and live membership without rewriting its receipt', async () => {
  for (const change of ['wire', 'receiver', 'bytes', 'retention', 'membership'] as const) {
    const w = await world();
    try {
      const { envelope, receipt, current } = await fresh(w, 'file', { id: w.refs[0] });
      if (change === 'wire') await updateRow(w.store, model, current, { data: { ...current.data, file: { id: w.refs[1] } } });
      if (change === 'receiver') {
        const stored = w.physical.files.get(w.refs[0]!); assert.ok(stored);
        w.physical.files.put({ ...stored, owner: { ...stored.owner, principal: 'different-principal' } });
      }
      if (change === 'bytes') w.physical.blobs.write(blobKeyForFile(w.refs[0]!), new Uint8Array(bytes.length).fill(120));
      if (change === 'retention') w.setNow(FIXED_NOW + retention.retentionMs + 1);
      if (change === 'membership') await w.identities.removeMembership(w.membership.membership_id);
      const before = await w.snapshot(envelope), counters = w.counters();
      const retainedBefore = w.retentions();
      for (const dedicated of [true, false]) {
        const invoker = w.invoker(true, dedicated);
        const outcome = dedicated ? await invoker.invokeRetainedMutation(envelope, w.identity)
          : await invoker.invokeMutation(envelope, w.identity);
        if (change === 'membership') {
          if (dedicated) assert.ok('error' in outcome, JSON.stringify(outcome));
          else {
            assert.ok('result' in outcome, JSON.stringify(outcome));
            assert.equal(outcome.result.status, 'replayed');
            assert.equal(outcome.result.result, null); assert.deepEqual(outcome.result.records, []);
          }
        }
        else {
          assert.ok('result' in outcome, JSON.stringify(outcome)); assert.equal(outcome.result.status, 'replayed');
          assert.equal(outcome.result.result, 'updated', 'independent literal text survives File withholding');
          assert.equal(Object.hasOwn(records(outcome.result)[0]!.data, 'file'), false);
          assert.equal(records(outcome.result)[0]!.data['visible'], 'assigned visible');
        }
        assert.deepEqual(await w.snapshot(envelope), before); assert.deepEqual(w.counters(), counters);
        assert.equal(w.retentions(), retainedBefore, 'withheld File fields cannot authorize attachment repair');
      }
      assert.deepEqual(await w.store.readReceipt(w.receiptIdentity(envelope)), receipt);
    } finally { await w.close(); }
  }
});

test('a changed genuine host File binding cannot replace the receiving port of an executed checked definition', async () => {
  const w = await world();
  try {
    const { envelope } = await fresh(w, 'file', { id: w.refs[0] });
    const before = await w.snapshot(envelope), counters = w.counters(), retentions = w.retentions();
    const kernel = createFileJourneyKernel(createSqliteFileBindings(w.physical,
      { clock: { nowMs: () => FIXED_NOW }, intentTtlMs: 60_000, urlBase: 'https://test.invalid' }));
    const substituted = buildInvoker(w.compiled, w.asm, w.store, { appId: app,
      memberships: w.identities, now: () => FIXED_NOW, files: createCanonicalFileBinding(kernel, retention) });
    const outcome = await substituted.invokeMutation(envelope, w.identity);
    assert.ok('error' in outcome, JSON.stringify(outcome));
    assert.match(outcome.error.message, /original installed receiving port/);
    assert.deepEqual(await w.snapshot(envelope), before); assert.deepEqual(w.counters(), counters);
    assert.equal(w.retentions(), retentions);
  } finally { await w.close(); }
});

test('rename-only checked scenarios never inspect optional File ports for fresh or saved execution on a row containing a genuine File', async () => {
  const w = await world();
  try {
    const baseline = await fresh(w, 'file', { id: w.refs[0] });
    assert.equal(w.physical.files.get(w.refs[0]!)?.attachedRecord, `${model}/${w.row.id}/file`);
    const envelope = { operation: `${app}.rename`, operation_id: uuidv7(FIXED_NOW, ++sequence),
      inputs: { record: { id: baseline.current.id, version: String(baseline.current.version) } } };
    let filePropertyReads = 0;
    const fileTripwire = new Proxy({}, { get() { filePropertyReads++; throw new Error('rename optional File property tripwire'); } }) as
      NonNullable<NonNullable<Parameters<typeof buildInvoker>[3]>['files']>;
    const batches: Parameters<StoragePort['commit']>[0][] = [];
    const store: StoragePort = { ...w.store, commit: async batch => { batches.push(batch); return w.store.commit(batch); } };
    const invoker = (selected: StoragePort, aged = false) => buildInvoker(w.compiled, w.asm, selected,
      { appId: app, memberships: w.identities, now: () => FIXED_NOW + (aged ? 16 * 60000 : 0), files: fileTripwire });
    const before = await w.snapshot(envelope), counters = w.counters(), retentions = w.retentions();
    const freshRename = await invoker(store).invokeMutation(envelope, w.identity);
    assert.ok('result' in freshRename, JSON.stringify(freshRename));
    assert.equal(freshRename.result.status, 'committed'); assert.equal(freshRename.result.result, 'updated');
    assert.equal(filePropertyReads, 0); assert.equal(batches.length, 1);
    const current = await w.store.load(model, w.row.id); assert.ok(current);
    assert.equal(current.version, baseline.current.version + 1);
    assert.deepEqual(current.data, { ...baseline.current.data, visible: 'renamed visible' });
    assert.equal(batches[0]!.writes.length, 1); assert.equal(batches[0]!.history.length, 1);
    assert.deepEqual(batches[0]!.history[0], { model, recordId: current.id, version: current.version,
      operation: envelope.operation, operationId: envelope.operation_id, actor: w.identity.actor!.user_id, at: FIXED_NOW,
      change: 'update', before: baseline.current.data, after: current.data });
    for (const effects of [batches[0]!.outbox, batches[0]!.schedules, batches[0]!.uniqueClaims, batches[0]!.uniqueReleases]) {
      assert.deepEqual(effects, []);
    }
    const receipt = await w.store.readReceipt(w.receiptIdentity(envelope)); assert.ok(receipt);
    assert.equal(receipt.outcome.status, 'committed'); assert.deepEqual(batches[0]!.receipt, receipt);
    const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
    assert.deepEqual(association.fileAssignments ?? [], []); assert.deepEqual(association.changed.map(change => change.row), [current]);
    const after = await w.snapshot(envelope);
    assert.equal(after.revision, before.revision + 1); assert.deepEqual(after.rows, [current]);
    assert.deepEqual(after.history, [...before.history, ...batches[0]!.history]);
    for (const key of ['files', 'intents', 'bytes', 'outbox', 'schedules', 'membership'] as const) assert.deepEqual(after[key], before[key]);
    assert.deepEqual(await w.store.readReceipt(w.receiptIdentity(baseline.envelope)), baseline.receipt);
    assert.deepEqual(w.counters(), { ...counters, executions: counters.executions + 1 }); assert.equal(w.retentions(), retentions);
    let replayCommits = 0;
    const readonlyStore: StoragePort = { ...w.store, commit: async () => { replayCommits++; throw new Error('rename replay commit tripwire'); } };
    const afterCounters = w.counters();
    for (const dedicated of [false, true]) {
      const selected = invoker(readonlyStore, dedicated);
      const saved = dedicated ? await selected.invokeRetainedMutation(envelope, w.identity) : await selected.invokeMutation(envelope, w.identity);
      assert.ok('result' in saved, JSON.stringify(saved)); assert.equal(saved.result.status, 'replayed'); assert.equal(saved.result.result, 'updated');
      assert.equal(filePropertyReads, 0); assert.equal(replayCommits, 0); assert.equal(batches.length, 1);
      assert.deepEqual(await w.snapshot(envelope), after); assert.deepEqual(w.counters(), afterCounters);
      assert.equal(w.retentions(), retentions);
      assert.deepEqual(await w.store.readReceipt(w.receiptIdentity(baseline.envelope)), baseline.receipt);
    }
  } finally { await w.close(); }
});
