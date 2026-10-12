/** Typed File traversal establishes schema/wire correspondence only, no physical authority. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtifactModel, CanTypeId } from '@canlang/contracts';
import { parseTypeId } from '@canlang/values';
import { StateError } from '../../src/errors.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { storedNominalField, storedNominalFileRefs, storedNominalWire } from '../../src/invocation/scenario-stored-value.js';
import { asModel } from './fixtures.js';

const BRANCH = asModel('StoredFiles.Branch'), TARGET = asModel('StoredFiles.Target');
const MESSAGE = 'std.TextMessage', BATCH = 'StoredFiles.Batch', ENVELOPE = 'StoredFiles.Envelope';
const refuses = (error: unknown) => error instanceof StateError && error.code === 'validation';
function fixture(type = `${MESSAGE}[]`, attachmentType = 'file[]', pure = false) {
  const parsed = parseTypeId(type);
  const model: ArtifactModel = { name: BRANCH, deleteMode: 'archive', fields: [{
    name: 'prefix', field: { kind: 'nominal', name: parsed.base.kind === 'nominal' ? parsed.base.path : '' },
    valueType: type as CanTypeId, required: true, serverOnly: false,
    ...(parsed.array ? { array: { required: parsed.requiredArray } } : {}),
    ...(parsed.nullable ? { nullable: true } : {}),
    ...(parsed.requiredArray ? { min: 1, max: 4 } : {}),
  }] };
  const slice: ArtifactDescriptorSlice = { artifact_version: 1, operations: [], models: [model,
    { name: TARGET, deleteMode: 'archive', fields: [] }], valueTypes: {
      contracts: [
        { name: MESSAGE, fields: [
          { name: 'role', type: 'enum(system,user,assistant)' as CanTypeId },
          { name: 'content', type: 'text' as CanTypeId, max: 100 },
          ...(pure ? [] : [{ name: 'attachments', type: attachmentType as CanTypeId, max: 8 }]),
        ] },
        { name: BATCH, fields: [{ name: 'messages', type: `${MESSAGE}[]` as CanTypeId }, { name: 'cover', type: 'file?' as CanTypeId }] },
        { name: ENVELOPE, fields: [{ name: 'batches', type: `${BATCH}[]!` as CanTypeId, min: 1, max: 4 },
          { name: 'label', type: 'StoredFiles.Tag' as CanTypeId }, { name: 'related', type: TARGET }] },
      ], aliases: [{ name: 'StoredFiles.Tag', type: 'text', min: 1, max: 12, format: 'name' }],
    } };
  const loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const bound = { artifactModels: new Map(slice.models!.map(model => [asModel(model.name), model])),
    canonicalModels: loaded.models, valueSchema: loaded.valueSchema };
  return { bound, profile: storedNominalField(bound, BRANCH, 'prefix', type, { protectedFiles: true }) };
}
const message = (ids: readonly string[] = []) => ({ role: 'user', content: 'Declared text', attachments: ids.map(id => ({ id })) });

test('original TextMessage array retains ordered duplicate File refs and empty declared receiver requirement', () => {
  const { profile, bound } = fixture();
  assert.throws(() => storedNominalField(bound, BRANCH, 'prefix', `${MESSAGE}[]`), /requires its defining join/);
  assert.equal(profile.hasFiles, true); assert.ok(Object.isFrozen(profile));
  const wire = [message(['file-a', 'file-b', 'file-a']), message([]), message(['file-c'])];
  storedNominalWire(profile, wire);
  const refs = storedNominalFileRefs(profile, wire);
  assert.deepEqual(refs, ['file-a', 'file-b', 'file-a', 'file-c']); assert.ok(Object.isFrozen(refs));
  assert.deepEqual(storedNominalFileRefs(profile, []), []);
  assert.deepEqual(storedNominalFileRefs(profile, [message()]), []);
  assert.deepEqual(wire[0]!.attachments, [{ id: 'file-a' }, { id: 'file-b' }, { id: 'file-a' }]);
});

test('declared nested contracts, nullable File leaves and text aliases preserve order without model-ref promotion', () => {
  const { profile } = fixture(ENVELOPE);
  assert.deepEqual(storedNominalFileRefs(profile, { batches: [
    { messages: [message(['first', 'same'])], cover: { id: 'cover' } },
    { messages: [message(['same'])], cover: null },
  ], label: 'batch', related: { id: 'ordinary-model-id', version: '1' } }), ['first', 'same', 'cover', 'same']);
  const pure = fixture(`${MESSAGE}[]`, 'file[]', true).profile;
  assert.equal(pure.hasFiles, false);
  assert.deepEqual(storedNominalFileRefs(pure, [{ role: 'assistant', content: 'Pure' }]), []);
});

test('whole canonical nullable/required array boundaries and owning constraints remain checked', () => {
  const nullable = fixture(`${MESSAGE}[]?`).profile;
  assert.deepEqual(storedNominalFileRefs(nullable, null), []);
  const required = fixture(`${MESSAGE}[]!`).profile;
  assert.deepEqual(storedNominalFileRefs(required, [message(['valid'])]), ['valid']);
  for (const value of [null, [], Array.from({ length: 5 }, () => message()), [{ ...message(), content: 'x'.repeat(101) }]]) {
    assert.throws(() => storedNominalFileRefs(required, value), refuses);
  }
  const requiredFiles = fixture(`${MESSAGE}[]`, 'file[]!').profile;
  // []! requires an explicitly supplied array; nonemptiness needs min=1.
  assert.deepEqual(storedNominalFileRefs(requiredFiles, [message()]), []);
  assert.throws(() => storedNominalFileRefs(requiredFiles, [{ role: 'user', content: 'Text' }]), refuses);
  assert.throws(() => storedNominalFileRefs(requiredFiles, [{ ...message(), attachments: null }]), refuses);
});

test('schema/wire-only File traversal refuses unknown/protected declarations and fabricated authority shapes', () => {
  const { profile, bound } = fixture();
  for (const attachments of [[{ id: '' }], ['raw-id'], [{ url: 'https://provider.invalid/output.png' }],
    [{ id: 'file', version: '1' }], [{ id: 'file', receiver: 'foreign' }], null]) {
    assert.throws(() => storedNominalFileRefs(profile, [{ ...message(), attachments }]), refuses);
  }
  for (const wire of [[{ ...message(), undeclared: { id: 'fake-file' } }], [{ ...message(), role: 'tool' }], {}]) {
    assert.throws(() => storedNominalFileRefs(profile, wire), refuses);
  }
  let getters = 0;
  const hostile = { role: 'user', content: 'Text' };
  Object.defineProperty(hostile, 'attachments', { enumerable: true, get() { getters++; return [{ id: 'file' }]; } });
  assert.throws(() => storedNominalFileRefs(profile, [hostile]), refuses); assert.equal(getters, 0);
  assert.throws(() => storedNominalFileRefs({ ...profile }, [message()]), /authentic owning contract profile/);
  for (const type of ['member', 'secret', 'Undeclared.Nominal']) assert.throws(() => fixture(`${MESSAGE}[]`, type));
  const overlap = new Map(bound.artifactModels);
  overlap.set(asModel(MESSAGE), { name: MESSAGE, deleteMode: 'archive', fields: [] });
  assert.throws(() => storedNominalField({ ...bound, artifactModels: overlap }, BRANCH, 'prefix', `${MESSAGE}[]`,
    { protectedFiles: true }), /namespaces overlap/);
});
