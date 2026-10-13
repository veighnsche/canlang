/** Declaration-labelled Dev staging against installed State, Identity and SQLite Files.
 * This checks the host File lifecycle, not Compiler or native .can acceptance. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CanTypeId, CompileArtifact, ModelName, StoragePort } from '@canlang/contracts';
import { DEFAULT_FILE_POLICY, blobKeyForFile, ingestVerifiedEventBytes } from '@canlang/files';
import { readFinalizedFileObservation } from '@canlang/files/finalize';
import { createSqliteFileBindings, createSqliteFileStore } from '@canlang/files/host/sqlite';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFileJourneyKernel } from '@canlang/interfaces/uploads/kernel';
import { bindFileReferenceProfile, fileReferenceOccurrences } from '@canlang/state';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '@canlang/state/invocation/registry';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { FIXED_NOW, seedRow } from '@canlang/state/testing/invocation/fixtures';
import { createCanonicalFileBinding } from '../src/runtime/bound-files.js';
import { retainCommittedFiles, stageFileReferences, type FileStagingCensus } from '../src/runtime/file-staging.js';
import type { CanonicalExecutionEffects } from '../src/runtime/invoke.js';

const app = 'NominalStage', model = 'NominalStage.Record' as ModelName;
const definition = 'NominalStage.WorkflowDefinition' as CanTypeId;
const bytes = new TextEncoder().encode('actual nested File bytes\n');
const retention = { unattachedHorizonMs: 60_000, retentionMs: 120_000 };

function declarations(): ArtifactDescriptorSlice {
  const field = { name: 'definitions', field: { kind: 'nominal' as const, name: definition },
    valueType: `${definition}[]?` as CanTypeId, array: { required: false }, nullable: true,
    required: false, serverOnly: false };
  return { artifact_version: 1, valueTypes: { contracts: [{ name: definition, fields: [
    { name: 'graph', type: 'file' }, { name: 'label', type: 'text' },
  ] }] }, models: [{ name: model, deleteMode: 'archive', fields: [field] }], operations: [
    { name: `${model}.create`, kind: 'create', description: '', inputs: { fields: [
      { name: field.name, field: field.field, valueType: field.valueType,
        array: field.array, nullable: true, required: false },
    ] } },
    { name: `${model}.update`, kind: 'update', description: '', inputs: { fields: [
      { name: 'record', field: { kind: 'ref', model, requireVersion: true }, required: true },
      { name: field.name, field: field.field, valueType: field.valueType,
        array: field.array, nullable: true, required: false },
    ] } },
  ] };
}

function effects(kind: 'insert' | 'update', row: Awaited<ReturnType<typeof seedRow>>,
  wire: unknown, supplied = false): CanonicalExecutionEffects {
  const saved = { ...row, data: { definitions: wire } };
  return { history: [], outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {}, result: null,
    writes: [kind === 'insert' ? { kind, model, row: saved } :
    { kind, model, id: row.id, expectedVersion: row.version, row: saved }],
    ...(supplied ? { fileAssignments: [{ model, recordId: row.id, field: 'definitions' }] } : {}),
  };
}

test('nominal File staging validates nested refs, guards finalization and repairs top-field retention', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-nominal-stage-'));
  const physical = createSqliteFileStore(join(directory, 'files.sqlite'));
  try {
    const clock = createFrozenClock(FIXED_NOW), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({});
    const user = await identities.createUser({ email: 'nominal-stage@test.invalid', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = randomBytes(32).toString('hex');
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(FIXED_NOW + 4 * 86400000).toISOString(), last_team_id: team.team_id });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const receiver = { app, team: team.team_id, owner: team.team_id, principal: user.user_id };
    const finalize = (principal = user.user_id) => {
      const result = ingestVerifiedEventBytes({ clock, files: physical.files, blobs: physical.blobs,
        intents: physical.intents, fileIds: { nextFileId: () => randomUUID() } }, {
        provenance: { kind: 'event', source: 'deployment.mail', adapter: 'deployment.mail', occurrenceId: randomUUID(),
          fieldPath: 'attachments', itemIndex: 0 }, receiver: { ...receiver, principal },
        claimedType: 'text/plain', bytes, policy: DEFAULT_FILE_POLICY,
      });
      assert.equal(result.status, 'finalized');
      if (result.status !== 'finalized') throw new Error('Files finalization refused');
      return result.file.id;
    };
    const ref = finalize(), foreign = finalize('another-user'), absent = randomUUID();
    const kernel = createFileJourneyKernel(createSqliteFileBindings(physical, {
      clock, intentTtlMs: 60_000, urlBase: 'https://nominal-stage.invalid',
    }));
    const binding = createCanonicalFileBinding(kernel, retention);
    let validations = 0, retentions = 0, observations = 0, loseRetentionResponse = true;
    const files = { ...binding,
      validate: async (...args: Parameters<typeof binding.validate>) => { validations++; return binding.validate(...args); },
      retain: async (...args: Parameters<typeof binding.retain>) => {
        retentions++; await binding.retain(...args);
        if (loseRetentionResponse) { loseRetentionResponse = false; throw new Error('lost postcommit attachment response'); }
      },
      observe: async (...args: Parameters<NonNullable<typeof binding.observe>>) => {
        observations++; return binding.observe!(...args);
      },
    };
    const slice = declarations(), loaded = loadArtifactDescriptors(slice, { by: 'members' });
    assert.ok(loaded.valueSchema); assert.ok(loaded.valueTypes);
    const profile = bindFileReferenceProfile({ canonicalModels: loaded.models,
      artifactModels: new Map([[model, slice.models![0]!]]),
      valueSchema: loaded.valueSchema, valueTypes: loaded.valueTypes }, model, 'definitions');
    assert.equal(profile.fileBearing, true);
    const census: FileStagingCensus = { fields: new Map([[model, new Map([['definitions', profile]])]]),
      occurrences: fileReferenceOccurrences };
    const artifact = slice as CompileArtifact;
    const { store } = createTestMemoryStorage();
    const wire = [{ graph: { id: ref }, label: 'revision graph' }];
    const row = await seedRow(store, model, { data: { definitions: wire } });
    const common = { artifact, store: store as StoragePort, identity, app, files, census,
      refuse: (message: string): never => { throw new Error(message); } };
    const stage = (value: unknown, supplied = false, kind: 'insert' | 'update' = 'insert') =>
      stageFileReferences({ ...common, effects: effects(kind, row, value, supplied) });

    const staged = await stage(wire, true);
    assert.deepEqual(staged.attachments, [{ ref, record: `${model}/${row.id}/definitions` }]);
    assert.equal(staged.guards.length, 1);
    assert.equal(await staged.guards[0]!.evaluate(), true);
    await assert.rejects(stage([{ graph: { id: foreign }, label: 'foreign' }]), /finalized and owned/);
    await assert.rejects(stage([{ graph: { id: absent }, label: 'absent' }]), /finalized and owned/);
    await assert.rejects(stage([{ graph: { id: ref }, label: 23 }]), /File reference profile/);
    assert.equal(retentions, 0);

    const savedBytes = physical.blobs.read(blobKeyForFile(ref)); assert.ok(savedBytes);
    physical.blobs.remove(blobKeyForFile(ref));
    assert.equal(await staged.guards[0]!.evaluate(), false, 'lost physical bytes invalidate the final guard');
    await assert.rejects(stage(wire, true, 'update'), /finalized and owned/,
      'an identical caller-supplied field still validates its actual File');
    physical.blobs.write(blobKeyForFile(ref), savedBytes);
    const savedRecord = physical.files.get(ref); assert.ok(savedRecord);
    physical.files.put({ ...savedRecord, owner: { ...savedRecord.owner, principal: 'another-user' } });
    assert.equal(await staged.guards[0]!.evaluate(), false, 'changed receiver invalidates the final guard');
    physical.files.put(savedRecord);

    const beforeEmpty = validations;
    assert.deepEqual((await stage(null)).attachments, []);
    assert.deepEqual((await stage([])).attachments, []);
    assert.equal(validations, beforeEmpty, 'nullable and empty values do not call Files');
    await assert.rejects(stageFileReferences({ ...common, effects: effects('insert', row, wire),
      observeAssignment: () => { throw new Error('An unassigned field cannot acquire a saved observation'); } }), /genuine State receipt observation/);
    const captured: string[] = [];
    const nominal = await stageFileReferences({ ...common,
      effects: effects('insert', row, [wire[0], wire[0]], true),
      observeAssignment: input => {
        assert.equal(input.model, model); assert.equal(input.recordId, row.id); assert.equal(input.field, 'definitions');
        const actual = readFinalizedFileObservation(input.observation); assert.ok(actual);
        assert.deepEqual(actual.receiver, receiver); captured.push(actual.ref);
      } });
    assert.deepEqual(captured, [ref], 'one genuine observation per distinct File/top-field');
    assert.equal(observations, 1);
    assert.deepEqual(nominal.attachments, [staged.attachments[0], staged.attachments[0]], 'owning ordered duplicates remain in staging');

    const repair = () => retainCommittedFiles({ artifact, operation: `${model}.create`, inputs: {},
      result: { id: row.id }, attachments: [], store, files, census, identity, app });
    await assert.rejects(repair(), /lost postcommit attachment response/);
    assert.equal(physical.files.get(ref)?.attachedRecord, `${model}/${row.id}/definitions`);
    await repair();
    assert.equal(retentions, 2, 'a lost postcommit response repairs from the actual stored top field');
  } finally { physical.close(); await rm(directory, { recursive: true, force: true }); }
});
