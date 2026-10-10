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
import { bindDeclaredFileReferenceProfile, fileReferenceOccurrences } from '../dist/src/ports/file-reference-profile.js';
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
        grants: [{ by: 'members', fields: ['attachments.id', 'extras.id', 'optional.id'] }] }], loaded.models) });
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

    // Populate both source-declared nonrequired profiles through genuine CRUD.
    // The required attachment remains a separate sharing reference throughout.
    const populated = await call('create', { attachments: [wire(refs[1])],
      extras: [wire(refs[0]), wire(refs[1]), wire(refs[0])],
      optional: [wire(refs[1]), wire(refs[0]), wire(refs[1])] });
    assert.equal(populated.status, 'committed');
    let arrayRow = populated.result;
    const arrayLocator = (field, ref) => ({ model: MODEL, recordId: arrayRow.id, field, ref });
    const slots = async ref => (await consumer.observeReferences(ref)).references
      .filter(slot => slot.recordId === arrayRow.id)
      .map(slot => [slot.rowVersion, slot.field, slot.index, slot.path]);
    assert.deepEqual(await slots(refs[0]), [
      [arrayRow.version, 'extras', 0, [0]], [arrayRow.version, 'extras', 2, [2]],
      [arrayRow.version, 'optional', 1, [1]],
    ]);
    assert.deepEqual(await slots(refs[1]), [
      [arrayRow.version, 'attachments', 0, [0]], [arrayRow.version, 'extras', 1, [1]],
      [arrayRow.version, 'optional', 0, [0]], [arrayRow.version, 'optional', 2, [2]],
    ]);
    for (const field of ['extras', 'optional']) {
      for (const ref of refs) assert.deepEqual(await consumer.read(arrayLocator(field, ref), caller, consume), bytes);
      const reads = physicalReads;
      await withheld(() => partial.read(arrayLocator(field, refs[0]), caller, consume));
      assert.equal(physicalReads, reads, 'leaf grants cannot disclose either whole array');
    }
    const changeArrays = async patch => {
      const result = await call('update', { record: { id: arrayRow.id, version: String(arrayRow.version) }, ...patch });
      assert.equal(result.status, 'committed'); arrayRow = result.result;
      assert.deepEqual(await store.load(MODEL, arrayRow.id), arrayRow);
      assert.deepEqual(arrayRow.data.attachments, [wire(refs[1])]);
    };
    const beforeExtrasReplacement = await consumer.observeReferences(refs[0]);
    await changeArrays({ extras: [wire(refs[1])] });
    await assert.rejects(beforeExtrasReplacement.revalidate(), error => error instanceof StateError && error.code === 'conflict');
    assert.deepEqual(arrayRow.data.optional, populated.result.data.optional, 'omitted nullable array is retained');
    assert.deepEqual(await slots(refs[0]), [[arrayRow.version, 'optional', 1, [1]]]);
    let reads = physicalReads;
    await withheld(() => consumer.read(arrayLocator('extras', refs[0]), caller, consume));
    assert.equal(physicalReads, reads, 'ordinary replacement removes the old slot before physical reads');
    assert.deepEqual(await consumer.read(arrayLocator('optional', refs[0]), caller, consume), bytes);
    await changeArrays({ optional: [wire(refs[0]), wire(refs[0])] });
    assert.deepEqual(arrayRow.data.extras, [wire(refs[1])], 'omitted ordinary array is retained');
    assert.deepEqual(await slots(refs[0]), [
      [arrayRow.version, 'optional', 0, [0]], [arrayRow.version, 'optional', 1, [1]],
    ]);
    assert.deepEqual(await slots(refs[1]), [
      [arrayRow.version, 'attachments', 0, [0]], [arrayRow.version, 'extras', 0, [0]],
    ]);
    reads = physicalReads;
    await withheld(() => consumer.read(arrayLocator('optional', refs[1]), caller, consume));
    assert.equal(physicalReads, reads, 'nullable replacement removes only its old field slots');
    assert.deepEqual(await consumer.read(arrayLocator('extras', refs[1]), caller, consume), bytes);
    await changeArrays({ extras: [], optional: [] });
    assert.deepEqual(arrayRow.data.extras, []); assert.deepEqual(arrayRow.data.optional, []);
    assert.deepEqual(await slots(refs[0]), []);
    assert.deepEqual(await slots(refs[1]), [[arrayRow.version, 'attachments', 0, [0]]]);
    reads = physicalReads;
    for (const field of ['extras', 'optional']) for (const ref of refs) {
      await withheld(() => consumer.read(arrayLocator(field, ref), caller, consume));
    }
    assert.equal(physicalReads, reads, 'empty arrays preserve sharing without any stale byte callback');
    await changeArrays({ optional: null });
    assert.equal(arrayRow.data.optional, null); assert.deepEqual(arrayRow.data.extras, []);
    assert.deepEqual(await slots(refs[0]), []);
    for (const ref of refs) await withheld(() => consumer.read(arrayLocator('optional', ref), caller, consume));
    assert.equal(physicalReads, reads, 'null clearing grants no physical read');
    // Restore live non-null slots before actual revocation so the refusal is
    // specifically current membership loss, independent of clearing/archive.
    await changeArrays({ extras: [wire(refs[1])], optional: [wire(refs[0])] });
    assert.deepEqual(await consumer.read(arrayLocator('extras', refs[1]), caller, consume), bytes);
    assert.deepEqual(await consumer.read(arrayLocator('optional', refs[0]), caller, consume), bytes);
    const beforeRevocation = physicalReads;
    await memberships.removeMembership(membership.membership_id);
    await withheld(() => consumer.read({ ...currentLocator, recordId: surviving.result.id }, caller, consume));
    await withheld(() => consumer.read(arrayLocator('extras', refs[1]), caller, consume));
    await withheld(() => consumer.read(arrayLocator('optional', refs[0]), caller, consume));
    assert.equal(physicalReads, beforeRevocation, 'revoked membership must not reach any current File array bytes');
    assert.deepEqual(await store.load(MODEL, surviving.result.id), surviving.result);
    assert.deepEqual(await store.load(MODEL, arrayRow.id), arrayRow);
  } finally {
    physical?.close(); rmSync(scratch, { recursive: true, force: true });
  }
});

// Internal typed traversal component only. Source generation establishes the
// actual declaration types here; origin, census admission and native hosting
// qualification belong to their owning consumers.
test('original source declaration types bind complete canonical nested File profiles without invented model fields', {
  skip: 'Compiler-owned E6008 prerequisite: genuine §13 field-schema lowering for FileProfile.Packet|FileProfile.Empty at Bundle.choice is pending.',
}, () => {
  const scratch = mkdtempSync(join(root, 'compiler/target/file-declared-profile-'));
  try {
    const input = join(scratch, 'Profiles.can');
    writeFileSync(input, `app FileProfile
Given
 Record {attachments:file[]! min=1 max=2,label:text trim min=1 max=5}
 policy Record read=members
 contract Packet {attachments:file[]! min=1 max=3,optional:file?,related:Record?,label:text trim max=5,state:enum(open,closed)}
 contract Empty {note:text}
 contract Bundle {choice:Packet|Empty,extras:file[],optional:file[]?}
When
 scenario inspect(payload:Bundle) read=true -> Bundle by=members
  do return payload
 scenario inspectNullable(payload:Bundle?) read=true -> Bundle? by=members
  do return payload
 scenario bounded(values:Record.attachments) read=true -> file[] by=members
  do return values
Then
`);
    const compileEnv = { ...process.env }; delete compileEnv.CAN_CATALOG;
    const compiled = spawnSync(resolve(process.argv[2] ?? join(root, 'compiler/target/debug/can')),
      ['compile', '--format=json', '--catalog', join(root, 'packages/values/dist/catalog.json'), input],
      { encoding: 'utf8', env: compileEnv });
    assert.equal(compiled.status, 0, compiled.error?.message ?? compiled.stderr + compiled.stdout);
    const artifact = JSON.parse(compiled.stdout);
    const loaded = loadArtifactDescriptors(artifact, { by: 'members' });
    const bound = { artifactModels: new Map(artifact.models.map(model => [model.name, model])),
      canonicalModels: loaded.models, valueSchema: loaded.valueSchema, valueTypes: loaded.valueTypes };
    const original = loaded.registry.get('FileProfile.inspect').descriptor;
    const declaration = original.inputs.find(input => input.name === 'payload');
    assert.equal(declaration.valueType, 'FileProfile.Bundle');
    assert.equal(original.result.type, declaration.valueType);
    const profile = bindDeclaredFileReferenceProfile(bound, declaration.valueType, declaration);
    const resultProfile = bindDeclaredFileReferenceProfile(bound, original.result.type);
    assert.equal(profile.fileBearing, true);
    const wire = { choice: { type: 'FileProfile.Packet', value: {
      attachments: [{ id: 'alpha' }, { id: 'alpha' }], optional: { id: 'beta' },
      related: { id: 'record', version: '1' }, label: 'label', state: 'open',
    } }, extras: [{ id: 'gamma' }], optional: null };
    const expected = [
      { ref: 'alpha', path: ['choice', 'value', 'attachments', 0] },
      { ref: 'alpha', path: ['choice', 'value', 'attachments', 1] },
      { ref: 'beta', path: ['choice', 'value', 'optional'] },
      { ref: 'gamma', path: ['extras', 0] },
    ];
    assert.deepEqual(fileReferenceOccurrences(profile, wire), expected);
    assert.deepEqual(fileReferenceOccurrences(resultProfile, wire), expected);
    const optional = loaded.registry.get('FileProfile.inspectNullable').descriptor.inputs[0];
    const nullableProfile = bindDeclaredFileReferenceProfile(bound, optional.valueType, optional);
    assert.deepEqual(fileReferenceOccurrences(nullableProfile, null), []);
    assert.deepEqual(fileReferenceOccurrences(nullableProfile, wire), expected);
    assert.deepEqual(fileReferenceOccurrences(profile, { choice: { type: 'FileProfile.Empty', value: { note: 'none' } },
      extras: [], optional: [{ id: 'delta' }] }), [{ ref: 'delta', path: ['optional', 0] }]);
    for (const mutate of [
      copy => { copy.choice.value.attachments = []; },
      copy => { copy.choice.value.attachments[0].url = 'https://invalid.test'; },
      copy => { copy.choice.value.optional = { id: 7 }; },
      copy => { copy.choice.value.label = ' label '; },
      copy => { copy.choice.value.label = 'overbound'; },
      copy => { copy.choice.value.state = 'missing'; },
      copy => { copy.choice.value.related.version = '01'; },
      copy => { copy.choice.type = 'FileProfile.Missing'; },
      copy => { copy.choice.authority = true; },
      copy => { delete copy.extras; },
      copy => { copy.optional = [null]; },
    ]) {
      const malformed = structuredClone(wire); mutate(malformed);
      assert.throws(() => fileReferenceOccurrences(profile, malformed), error => error instanceof StateError);
    }
    assert.throws(() => fileReferenceOccurrences({ ...profile }, wire), error => error instanceof StateError);
    for (const type of ['FileProfile.Missing', 'file []', 'text|FileProfile.Packet']) {
      assert.throws(() => bindDeclaredFileReferenceProfile(bound, type), error => error instanceof StateError);
    }
    const bounded = loaded.registry.get('FileProfile.bounded').descriptor.inputs.find(input => input.name === 'values');
    assert.equal(bounded.min, 1); assert.equal(bounded.max, 2);
    assert.equal(bounded.valueType, 'file[]');
    const boundedProfile = bindDeclaredFileReferenceProfile(bound, bounded.valueType, bounded);
    const required = loaded.models.find(model => model.name === 'FileProfile.Record').fields.attachments;
    assert.equal(required.valueType, 'file[]!'); assert.deepEqual(required.array, { required: true });
    const requiredProfile = bindDeclaredFileReferenceProfile(bound, required.valueType, required);
    for (const profile of [boundedProfile, requiredProfile]) {
      assert.deepEqual(fileReferenceOccurrences(profile, [{ id: 'alpha' }]), [{ ref: 'alpha', path: [0] }]);
      for (const wire of [[], Array(3).fill({ id: 'alpha' }), undefined, null]) {
        assert.throws(() => fileReferenceOccurrences(profile, wire), error => error instanceof StateError);
      }
    }
    const label = loaded.models.find(model => model.name === 'FileProfile.Record').fields.label;
    const text = bindDeclaredFileReferenceProfile(bound, label.valueType, label);
    assert.equal(text.fileBearing, false);
    assert.deepEqual(fileReferenceOccurrences(text, 'label'), []);
    for (const value of [' label ', '', 'longer']) {
      assert.throws(() => fileReferenceOccurrences(text, value), error => error instanceof StateError);
    }
    for (const constraint of [{ ...bounded, valueType: 'file[]!' }, { ...bounded, min: -1 },
      { ...bounded, max: undefined }, { ...bounded, trim: true }]) {
      assert.throws(() => bindDeclaredFileReferenceProfile(bound, bounded.valueType, constraint), error => error instanceof StateError);
    }
    const skewed = structuredClone(loaded.valueTypes);
    skewed.contracts = skewed.contracts.filter(contract => contract.name !== 'FileProfile.Packet');
    assert.throws(() => bindDeclaredFileReferenceProfile({ ...bound, valueTypes: skewed }, declaration.valueType),
      error => error instanceof StateError);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
