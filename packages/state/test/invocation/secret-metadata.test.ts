import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelName } from '@canlang/contracts';
import { artifactToDescriptorSet, loadArtifactDescriptors } from '../../src/invocation/registry.js';
import { T18_SHOP_ARTIFACT_JSON } from '../../src/mutation/t18-shop.artifact.js';

const model = 'Shop.Team' as ModelName;
const artifact = () => JSON.parse(T18_SHOP_ARTIFACT_JSON);
const opts = { by: () => 'public' as const };

test('typed secrets travel beside canonical descriptors, while actor/now stamps stay ordinary fields', () => {
  const converted = artifactToDescriptorSet(artifact());
  assert.deepEqual([...converted.secretFields.get(model)!], ['token']);
  const loaded = loadArtifactDescriptors(artifact(), opts);
  assert.deepEqual([...loaded.secretFields.get(model)!], ['token']);
  assert.equal(loaded.serverInits.get(model)!.get('made'), 'now');
  assert.equal(loaded.serverInits.get(model)!.get('by'), 'actor');
  assert.equal(Object.hasOwn(loaded.models[0]!.fields.token!, 'secret'), false);
});

test('arrays and own-key names carry explicit secret tags; unknown nested tags are not guessed', () => {
  const raw = artifact();
  raw.models[0].fields.push(
    { name: 'constructor', field: { kind: 'secret' }, required: false, serverOnly: false, array: { required: false } },
    { name: 'toString', field: { kind: 'secret' }, required: false, serverOnly: false },
    { name: 'nested', field: { kind: 'other', type: 'Contract', fields: { token: { kind: 'secret' } } }, required: false, serverOnly: false },
  );
  const loaded = loadArtifactDescriptors(raw, opts);
  assert.deepEqual([...loaded.secretFields.get(model)!], ['token', 'constructor', 'toString']);
  assert.equal(loaded.models[0]!.fields['constructor']!.array!.required, false);
});

test('legacy missing additive tags remain supported, inherited tags never prove secrecy', () => {
  const raw = artifact();
  delete raw.models[0].fields.at(-1).field;
  assert.deepEqual([...loadArtifactDescriptors(raw, opts).secretFields.get(model)!], []);
  raw.models[0].fields.at(-1).field = Object.create({ kind: 'secret' });
  assert.deepEqual([...loadArtifactDescriptors(raw, opts).secretFields.get(model)!], []);
});

test('duplicate fields and malformed ordinary envelopes still reject the complete artifact', () => {
  const duplicate = artifact();
  duplicate.models[0].fields.push(duplicate.models[0].fields.at(-1));
  assert.throws(() => loadArtifactDescriptors(duplicate, opts), /Duplicate/);
  const malformed = artifact();
  malformed.models[0].fields.at(-1).array = { required: 'no' };
  assert.throws(() => loadArtifactDescriptors(malformed, opts), /array/);
});
