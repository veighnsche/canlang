/** Genuine installed State/Work/File component census; no native source qualification claim. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanTypeId, FileReferenceInventory, FrameworkFilePayloadOrigin, FrameworkOpaqueDeclarationSet,
  FrameworkOpaqueSendGuardDeclaration, FileRetirementAuthority, InstalledSnapshot, StoredRow } from '@canlang/contracts';
import { DEFAULT_FILE_POLICY, readFinalizedFileObservation } from '@canlang/files';
import { createSqliteFileStore, createSqliteFileBindings } from '@canlang/files/host/sqlite';
import type { SystemStaging } from '@canlang/state';
import { STATE_FILE_REFERENCE_PRODUCER, createTestMemoryStorage, prepareFrameworkFilePayloadOrigin } from '@canlang/state/storage';
import { loadArtifactDescriptors, isGeneratedOperationDef } from '@canlang/state/invocation/registry';
import { asId, asOperationId, asRevision, asVersion, makeBatch } from '@canlang/state/testing/invocation/fixtures';
import { stageCanonicalSend } from '../src/kernel/dispatch-staging.js';
import { WORK_FILE_REFERENCE_PRODUCER } from '../src/kernel/file-reference-inventory.js';
import { WORK_DISPATCH_MODEL, readDispatchRow } from '../src/kernel/tables.js';

const source = { path: 'guard-files.can', sha256: 'a'.repeat(64), module: 'guard-files.mjs' };
const rule = 'Guard.generate.send.0', target = 'std.TextGenerationV1.generate', meta = { actor: 'owner', now: 100 };
const scope = { app: 'guard-app', owner: 'team', ownerPackage: 'Guard' };
const guard: FrameworkOpaqueSendGuardDeclaration = { rule, source, owner: 'Guard.generate', node: { start: 10, end: 30 },
  binding: 'Guard.Text', target, inputs: [{ name: 'bundle', type: 'Guard.Files?' as CanTypeId }] };
const producers = [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER];
const snapshot: InstalledSnapshot = { owner: 'Guard', snapshotId: 'guard-source', digest: 'guard-digest', installedAt: 100, installedRevision: asRevision(1) };
const originalContracts = { 'Guard.Files': { fields: { optional: { type: 'file?' }, items: { type: 'file[]' } } } };
function inventory(fileFree = false): FileReferenceInventory {
  const declaration: FrameworkOpaqueSendGuardDeclaration = fileFree ? { ...guard, inputs: [{ name: 'bundle', type: 'bool' as CanTypeId }] } : guard;
  const artifactInput = fileFree ? { name: 'bundle', field: { kind: 'boolean' as const }, valueType: 'bool' as CanTypeId, required: true } :
    { name: 'bundle', field: { kind: 'nominal' as const, name: 'Guard.Files' },
      valueType: 'Guard.Files?' as CanTypeId, nullable: true, required: true };
  const loaded = loadArtifactDescriptors({ artifact_version: 1, models: [],
    valueTypes: { contracts: [{ name: 'Guard.Files', fields: [
      { name: 'optional', type: 'file?' as CanTypeId }, { name: 'items', type: 'file[]' as CanTypeId },
    ] }] }, operations: [{ name: 'Guard.generate', kind: 'scenario', description: '', inputs: { fields: [artifactInput] } }] }, { by: 'members' });
  const operation = loaded.registry.get('Guard.generate'); assert.ok(operation && isGeneratedOperationDef(operation));
  const set: FrameworkOpaqueDeclarationSet = { id: 'guard/declarations', inventory: { owner: snapshot.owner, snapshotId: snapshot.snapshotId, digest: snapshot.digest },
    snapshot, sources: [{ path: source.path, sha256: source.sha256 }], canonicalModels: loaded.models,
    artifactModels: [], valueTypes: loaded.valueTypes!, originalContracts, valueDefaults: [], declarations: [{
      id: 'guard/lexical', source: { kind: 'send-guard', ...declaration },
      profile: { kind: 'inputs', canonical: operation.descriptor.inputs, artifact: [artifactInput] },
    }] };
  return { owner: snapshot.owner, snapshotId: snapshot.snapshotId, digest: snapshot.digest,
    canonicalModels: loaded.models, artifactModels: [], valueTypes: loaded.valueTypes!,
    frameworkModels: producers.flatMap(producer => producer.models), opaqueDeclarationSets: [set] };
}
async function world(fileFree = false) {
  const declaration: FrameworkOpaqueSendGuardDeclaration = fileFree ? { ...guard, inputs: [{ name: 'bundle', type: 'bool' as CanTypeId }] } : guard;
  const dir = mkdtempSync(join(tmpdir(), 'can-send-guard-files-'));
  const physical = createSqliteFileStore(join(dir, 'files.sqlite'));
  const authority: FileRetirementAuthority = { app: scope.app, stateOwner: snapshot.owner, stateStoreId: 'state',
    fileStoreId: physical.fileStoreId, receiver: { app: scope.app, team: scope.owner, owner: scope.owner } };
  const memory = createTestMemoryStorage(authority, producers), store = memory.store;
  const files = createSqliteFileBindings(physical, { clock: { nowMs: () => 100 }, policy: DEFAULT_FILE_POLICY,
    intentTtlMs: 60000, urlBase: 'https://guard.example.test' });
  const receiver = { ...authority.receiver, principal: 'caller' };
  const finalized = files.finalizeProviderOutput({ receiver, binding: { adapter: 'guard-file-provider', deliveryId: 'file-delivery', resultPath: 'output' },
    operation: target, field: '/output', args: {}, name: 'result.txt', claimedType: 'text/plain', bytes: new TextEncoder().encode('file') });
  assert.equal(finalized.status, 'finalized'); if (finalized.status !== 'finalized') throw new Error('actual File finalization refused');
  const observation = files.observeFile(finalized.file.id, receiver, { unattachedHorizonMs: 1000, retentionMs: 2000 }); assert.ok(observation);
  await store.installFileReferenceInventory({ expectedRevision: await store.readRevision(), authority, snapshot, inventory: inventory(fileFree) });
  const ctx = Object.freeze({ ...meta, operation: 'Guard.generate', load: store.load, query: store.query });
  async function stage(bundle: unknown, facts: readonly { path: readonly (string | number)[]; observation: unknown }[], present = true) {
    const input = Object.freeze({ operationId: 'guard-operation', source: target, occurrenceIndex: 0,
      request: { binding: guard.binding, from: 'text-install', arguments: { value: { source: 'request', revision: '7' } } }, originOccurrence: null,
      ...(present ? { sourceGuard: { rule, source, owner: guard.owner, node: guard.node, inputs: { bundle } } } : {}) });
    const staged = await stageCanonicalSend(input, ctx, present ? { prepareSourceGuardOrigin: async (row, intent) =>
      prepareFrameworkFilePayloadOrigin(store, { expectedRevision: await store.readRevision(), inventoryOwner: snapshot.owner,
        declarationSetId: 'guard/declarations', model: WORK_DISPATCH_MODEL, row, field: 'sourceGuard', scope,
        origin: { kind: 'send-guard', intent: { intentId: intent.intentId, operation: intent.operation,
          operationId: asOperationId(intent.operationId), target: intent.target, occurrenceIndex: intent.occurrenceIndex, dispatchGuard: rule },
          declaration, inputsDeclarationId: 'guard/lexical' }, files: facts }) } : undefined);
    return staged;
  }
  async function commit(effects: SystemStaging) { await store.commit(makeBatch(await store.readRevision(), effects)); }
  return { memory, store, physical, authority, observation, ref: finalized.file.id, stage, commit,
    close() { physical.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function stagedRow(effects: SystemStaging): StoredRow {
  const write = effects.writes?.find(entry => entry.model === WORK_DISPATCH_MODEL);
  assert.ok(write && write.kind !== 'remove'); return write.row;
}

test('absent optional source guard is valid; null and empty File-bearing values still retain genuine provenance headers', async () => {
  for (const payload of ['absent', 'null', 'empty', 'file-free'] as const) {
    const w = await world(payload === 'file-free');
    try {
      const staged = await w.stage(payload === 'null' ? null : payload === 'file-free' ? true : { optional: null, items: [] }, [], payload !== 'absent');
      const row = stagedRow(staged.effects);
      assert.equal(Object.hasOwn(row.data, 'sourceGuard'), payload !== 'absent');
      assert.equal(Object.hasOwn(row.data, 'filePayloadOrigin'), payload !== 'absent');
      await w.commit(staged.effects);
      assert.deepEqual((await w.memory.reopen(w.authority, producers).load(WORK_DISPATCH_MODEL, row.id))?.data, row.data);
    } finally { w.close(); }
  }
});

test('nested nullable and array lexical Files pin genuine observations across current metadata changes and reopen', async () => {
  const w = await world();
  try {
    const bundle = { optional: { id: w.ref }, items: [{ id: w.ref }] };
    const staged = await w.stage(bundle, [{ path: ['inputs', 'bundle', 'optional'], observation: w.observation },
      { path: ['inputs', 'bundle', 'items', 0], observation: w.observation }]);
    const row = stagedRow(staged.effects), header = row.data.filePayloadOrigin as FrameworkFilePayloadOrigin;
    assert.deepEqual(header.files.map(file => file.path), [['inputs', 'bundle', 'optional'], ['inputs', 'bundle', 'items', 0]]);
    assert(header.files.every(file => file.file.ref === w.ref));
    await w.commit(staged.effects);
    const current = await w.store.load(WORK_DISPATCH_MODEL, row.id); assert.ok(current);
    const updated = { ...current, version: asVersion(Number(current.version) + 1), data: { ...current.data, errorMessage: 'metadata only' } };
    await w.commit({ writes: [{ kind: 'update', model: WORK_DISPATCH_MODEL, id: current.id, expectedVersion: current.version, row: updated }] });
    const reopened = w.memory.reopen(w.authority, producers);
    const saved = await reopened.load(WORK_DISPATCH_MODEL, row.id); assert.ok(saved);
    assert.deepEqual(saved.data.filePayloadOrigin, header); assert.deepEqual(saved.data.sourceGuard, row.data.sourceGuard);
    assert.equal(readDispatchRow(saved).sourceGuard?.rule, rule);
  } finally { w.close(); }
});

test('missing or copied genuine File observations refuse complete lexical census without a write', async () => {
  for (const mode of ['missing', 'copy', 'wrong-path'] as const) {
    const w = await world();
    try {
      const facts = readFinalizedFileObservation(w.observation); assert.ok(facts);
      const revision = await w.store.readRevision();
      await assert.rejects(w.stage({ optional: null, items: [{ id: w.ref }] }, mode === 'missing' ? [] : [{
        path: mode === 'wrong-path' ? ['inputs', 'bundle', 'optional'] : ['inputs', 'bundle', 'items', 0],
        observation: mode === 'copy' ? structuredClone(facts) : w.observation,
      }]));
      assert.equal(await w.store.readRevision(), revision);
      assert.deepEqual(await w.store.query({ model: WORK_DISPATCH_MODEL, authority: 'owner' }), []);
    } finally { w.close(); }
  }
});

test('orphan or malformed guard/header pairs and foreign intent guards refuse atomically', async () => {
  for (const mode of ['orphan', 'missing-header', 'undefined', 'slot', 'intent'] as const) {
    const w = await world();
    try {
      const staged = await w.stage(null, []), original = structuredClone(stagedRow(staged.effects));
      const row = { ...original, data: { ...original.data } };
      if (mode === 'orphan') delete row.data.sourceGuard;
      if (mode === 'missing-header') delete row.data.filePayloadOrigin;
      if (mode === 'undefined') row.data.sourceGuard = undefined;
      if (mode === 'slot') {
        const header = row.data.filePayloadOrigin as FrameworkFilePayloadOrigin;
        row.data.filePayloadOrigin = { ...header, slot: { ...header.slot, id: asId('foreign') } };
      }
      if (mode === 'intent') {
        const header = row.data.filePayloadOrigin as FrameworkFilePayloadOrigin;
        assert.equal(header.origin.kind, 'send-guard');
        if (header.origin.kind !== 'send-guard') throw new Error('missing owning SEND origin');
        row.data.filePayloadOrigin = { ...header, origin: { ...header.origin, intent: { ...header.origin.intent, dispatchGuard: 'foreign-rule' } } };
      }
      const revision = await w.store.readRevision();
      await assert.rejects(w.commit({ writes: [{ kind: 'insert', model: WORK_DISPATCH_MODEL, row }] }));
      assert.equal(await w.store.readRevision(), revision);
    } finally { w.close(); }
  }
});
