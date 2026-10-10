/** Direct Compiler → State File workflow; run after the owning compiler build.
 * node packages/state/test/file-references-source.mjs [path/to/can]
 * This qualifies the source/State boundary with MemoryState and SQLite Files.
 * Native host, provider and cross-store deletion qualification remain separate.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { DEFAULT_FILE_POLICY, ingestVerifiedEventBytes, readCurrentFinalizedBytes } from '@canlang/files';
import { createSqliteFileStore } from '@canlang/files/host/sqlite';
import { createFileReferenceConsumer } from '../dist/src/index.js';
import { createMemoryStorage } from '../dist/src/storage/memory.js';
import { IncompatibleArtifactError, loadArtifactDescriptors } from '../dist/src/invocation/registry.js';
import { invoke } from '../dist/src/invocation/invoke.js';
import { generatedCrudExecute } from '../dist/src/mutation/crud.js';
import { buildModelTableFromCanonical } from '../dist/src/mutation/models.js';
import { buildPolicyTable } from '../dist/src/policy/grants.js';
import { StateError } from '../dist/src/errors.js';
import { FIXED_NOW, makeEnvelope, makeIdentity, uuidv7 } from '../dist/test/invocation/fixtures.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = `app FileSource
Given
 Record {attachments:file[]! min=1 max=4,extras:file[],optional:file[]?}
 policy Record read=members
When
 crud Record by=members fields=attachments,extras,optional
Then
`;
const MODEL = 'FileSource.Record';
const bytes = new TextEncoder().encode('actual finalized File source workflow\n');

test('real required File array source reaches winning State CRUD and current SQLite bytes', async () => {
  const scratch = mkdtempSync(join(root, 'compiler/target/file-source-state-'));
  let physical;
  try {
    const input = join(scratch, 'Files.can');
    writeFileSync(input, source);
    const compileEnv = { ...process.env }; delete compileEnv.CAN_CATALOG;
    const compiled = spawnSync(resolve(process.argv[2] ?? join(root, 'compiler/target/debug/can')),
      ['compile', '--format=json', '--catalog', join(root, 'packages/values/dist/catalog.json'), input],
      { encoding: 'utf8', env: compileEnv });
    assert.equal(compiled.status, 0, compiled.error?.message ?? compiled.stderr + compiled.stdout);
    const artifact = JSON.parse(compiled.stdout);
    const model = artifact.models.find(model => model.name === MODEL);
    assert.ok(model);
    for (const [name, type, marker] of [['attachments', 'file[]!', true], ['extras', 'file[]', false],
      ['optional', 'file[]?', false]]) {
      const field = model.fields.find(field => field.name === name);
      assert.equal(field.valueType, type);
      assert.deepEqual(field.array, { required: marker });
      for (const kind of ['create', 'update']) {
        const input = artifact.operations.find(operation => operation.name === `${MODEL}.${kind}`)
          .inputs.fields.find(field => field.name === name);
        assert.equal(input.valueType, type);
        assert.deepEqual(input.array, { required: marker });
      }
    }
    // Engine-local policies faithfully bind the source's literal members
    // declarations; this check does not certify generated native policy intake.
    const loaded = loadArtifactDescriptors(artifact, { by: 'members' });
    for (const mutate of [copy => { copy.models[0].fields[0].valueType = 'file[]'; },
      copy => { copy.operations.find(operation => operation.kind === 'create')
        .inputs.fields.find(field => field.name === 'attachments').valueType = 'file[]'; }]) {
      const malformed = structuredClone(artifact); mutate(malformed);
      assert.throws(() => loadArtifactDescriptors(malformed, { by: 'members' }),
        error => error instanceof IncompatibleArtifactError && error.reason === 'malformed_descriptor' &&
          error.message.includes('valueType disagrees'));
    }
    const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs,
      serverInits: loaded.serverInits, nullableFields: loaded.nullableFields, containment: loaded.containment,
      ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }) });
    const policy = buildPolicyTable([{ model: MODEL, secretFields: [],
      grants: [{ by: 'members', fields: ['attachments', 'extras', 'optional'] }] }], loaded.models);
    const store = createMemoryStorage(), clock = createFrozenClock(FIXED_NOW);
    const memberships = createMemoryIdentityStore({ clock });
    const team = await memberships.createTeam({ timezone: 'UTC' });
    const membership = await memberships.createMembership({ team_id: team.team_id,
      user_id: 'file-source-reader', is_owner: false, roles: [] });
    const identity = makeIdentity({ userId: membership.user_id, team, membership });
    const scope = { app: 'FileSource', team: team.team_id, owner: team.team_id };
    const caller = { ...scope, principal: membership.user_id };
    physical = createSqliteFileStore(join(scratch, 'files.sqlite'));
    const refs = Array.from({ length: 2 }, () => {
      const finalized = physical.transaction(() => ingestVerifiedEventBytes({ clock,
        files: physical.files, blobs: physical.blobs, intents: physical.intents,
        fileIds: { nextFileId: () => randomUUID() } }, {
        provenance: { kind: 'event', source: 'deployment.mail', adapter: 'deployment.mail',
          occurrenceId: randomUUID(), fieldPath: 'attachments', itemIndex: 0 },
        receiver: caller, claimedType: 'text/plain', bytes, policy: DEFAULT_FILE_POLICY,
      }));
      assert.equal(finalized.status, 'finalized'); return finalized.file.id;
    });
    let sequence = 400_000, executions = 0, physicalReads = 0;
    const crud = generatedCrudExecute({ table, store, ownerBounds: { maxRows: 20, maxWork: 1000 } });
    const execute = async (...args) => { executions++; return crud(...args); };
    const common = { registry: loaded.registry, store, memberships, identity,
      app: scope.app, source: 'test', clock, execute };
    const consumer = createFileReferenceConsumer({ scope, store, memberships, policy,
      canonicalModels: loaded.models, artifactModels: artifact.models, registry: loaded.registry,
      ...(loaded.valueTypes === undefined ? {} : { valueTypes: loaded.valueTypes }),
      maxRows: 20, maxReferences: 100 });
    const consume = slot => {
      physicalReads++;
      return physical.transaction(() => readCurrentFinalizedBytes({ clock, files: physical.files,
        blobs: physical.blobs }, slot.ref, caller,
      { policy: DEFAULT_FILE_POLICY, retention: { unattachedHorizonMs: 60_000, retentionMs: 120_000 } }));
    };
    const withheld = async action => {
      try { assert.equal(await action(), null); }
      catch (error) { assert.ok(error instanceof StateError); assert.equal(error.code, 'forbidden'); }
    };
    const wire = id => ({ id });
    const call = (kind, inputs, id = uuidv7(FIXED_NOW, ++sequence)) =>
      invoke({ ...common, envelope: makeEnvelope(`${MODEL}.${kind}`, id, inputs) });
    for (const input of [{}, { attachments: [] }, { attachments: Array(5).fill(wire(refs[0])) },
      { attachments: [{ id: refs[0], url: 'https://invalid.test' }] }]) {
      await assert.rejects(call('create', input), error => error instanceof StateError);
      assert.deepEqual((await consumer.observeReferences(refs[0])).references, []);
    }
    const createId = uuidv7(FIXED_NOW, ++sequence);
    const creationInput = { attachments: [wire(refs[0]), wire(refs[0])], optional: null };
    const created = await call('create', creationInput, createId);
    assert.equal(created.status, 'committed');
    const row = created.result;
    assert.deepEqual(await store.load(MODEL, row.id), row);
    assert.deepEqual(row.data, { ...creationInput, extras: [] });
    const locator = { model: MODEL, recordId: row.id, field: 'attachments', ref: refs[0] };
    const observation = await consumer.observeReferences(refs[0]);
    assert.deepEqual(observation.references.map(slot => [slot.recordId, slot.rowVersion, slot.field, slot.path]),
      [[row.id, row.version, 'attachments', [0]], [row.id, row.version, 'attachments', [1]]]);
    assert.deepEqual(await consumer.read(locator, caller, consume), bytes);
    const revision = await store.readRevision(), beforeReplay = executions;
    const replayed = await call('create', creationInput, createId);
    assert.equal(replayed.status, 'replayed');
    assert.equal(executions, beforeReplay); assert.equal(await store.readRevision(), revision);
    await observation.revalidate();
    const replacementInput = { record: { id: row.id, version: String(row.version) },
      attachments: [wire(refs[1])] };
    await assert.rejects(call('update', { ...replacementInput, attachments: [] }),
      error => error instanceof StateError);
    assert.deepEqual(await store.load(MODEL, row.id), row);
    // The rejected receipt advances the global fence while preserving the row
    // and every duplicate slot. A fresh complete observation captures that fence.
    await assert.rejects(observation.revalidate(), error => error instanceof StateError && error.code === 'conflict');
    const beforeReplacement = await consumer.observeReferences(refs[0]);
    assert.deepEqual(beforeReplacement.references, observation.references); await beforeReplacement.revalidate();
    const replaced = await call('update', replacementInput);
    assert.equal(replaced.status, 'committed');
    await assert.rejects(beforeReplacement.revalidate(), error => error instanceof StateError && error.code === 'conflict');
    assert.deepEqual((await consumer.observeReferences(refs[0])).references, []);
    await withheld(() => consumer.read(locator, caller, consume));
    assert.equal(physicalReads, 1, 'removed reference must not reach physical bytes');
    const currentLocator = { ...locator, ref: refs[1] };
    assert.deepEqual(await consumer.read(currentLocator, caller, consume), bytes);
    const beforeOldReplay = executions, afterReplaceRevision = await store.readRevision();
    assert.equal((await call('create', creationInput, createId)).status, 'replayed');
    assert.equal(executions, beforeOldReplay); assert.equal(await store.readRevision(), afterReplaceRevision);
    assert.deepEqual(await store.load(MODEL, row.id), replaced.result);
    assert.deepEqual((await consumer.observeReferences(refs[0])).references, []);
    const options = { scope, store, memberships, canonicalModels: loaded.models, artifactModels: artifact.models,
      registry: loaded.registry, ...(loaded.valueTypes === undefined ? {} : { valueTypes: loaded.valueTypes }),
      maxRows: 20, maxReferences: 100 };
    const partial = createFileReferenceConsumer({ ...options,
      policy: buildPolicyTable([{ model: MODEL, secretFields: [],
        grants: [{ by: 'members', fields: ['attachments.id'] }] }], loaded.models) });
    await withheld(() => partial.read(currentLocator, caller, consume));
    assert.equal(physicalReads, 2, 'partial field permission must not reach physical bytes');
    const surviving = await call('create', { attachments: [wire(refs[1])] });
    assert.equal(surviving.status, 'committed');
    const archived = await call('delete', { record: { id: row.id, version: String(replaced.result.version) } });
    assert.equal(archived.status, 'committed');
    const retained = await consumer.observeReferences(refs[1]);
    assert.equal(retained.references.length, 2);
    assert.equal(retained.references.find(slot => slot.recordId === row.id).archived, true);
    await withheld(() => consumer.read(currentLocator, caller, consume));
    await memberships.removeMembership(membership.membership_id);
    await withheld(() => consumer.read({ ...currentLocator, recordId: surviving.result.id }, caller, consume));
    assert.equal(physicalReads, 2, 'archived rows and revoked membership must not reach physical bytes');
    assert.deepEqual(await store.load(MODEL, surviving.result.id), surviving.result);
  } finally {
    physical?.close(); rmSync(scratch, { recursive: true, force: true });
  }
});
