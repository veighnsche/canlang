import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const [root, artifactPath, scratch] = process.argv.slice(2);
const require = createRequire(resolve(root, 'package.json'));
const load = specifier => import(pathToFileURL(require.resolve(specifier)));
const {loadArtifactFile} = await load('@canlang/cloudflare/runtime/artifact');
const {assembleModules} = await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker} = await load('@canlang/cloudflare/worker/assembly');
const {createTestMemoryStorage} = await load('@canlang/state/storage/memory');
const {FIXED_NOW, createMemoryIdentityStore, seedMember, makeIdentity, uuidv7} =
  await load('@canlang/state/testing/invocation/fixtures');
const loaded = loadArtifactFile(artifactPath), artifact = loaded.artifact;
const operation = 'NominalFieldReuse.accept';
const descriptor = artifact.operations.find(item => item.name === operation);
assert.equal(descriptor.kind, 'scenario');
const [input] = descriptor.inputs.fields;
assert.equal(input.name, 'state');
assert.equal(input.field.kind, 'enum');
assert.equal(input.required, true);
assert.equal(input.field.values.length, 5);
const stateField = artifact.models.find(model => model.name === 'NominalFieldReuse.Entry')
  .fields.find(field => field.name === 'state');
assert.deepEqual(input.field, stateField.field, 'model and scenario reuse the same owning closed enum');
assert.equal(input.valueType, `enum(${input.field.values.join(',')})`);
const assembly = await assembleModules(loaded, {
  workDir:resolve(scratch, 'modules'),
  stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
  uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {store} = createTestMemoryStorage(), memberships = createMemoryIdentityStore();
const member = await seedMember(memberships, {isOwner:false});
const identity = makeIdentity({membership:member.membership, email:member.user.email});
const invoker = buildInvoker(artifact, assembly, store, {memberships, now:()=>FIXED_NOW});
let sequence = 0;
const envelope = state => ({operation, operation_id:uuidv7(FIXED_NOW, ++sequence), inputs:{state}});
const receipt = request => store.readReceipt({app:'NominalFieldReuse', owner:identity.team.team_id,
  principal:identity.actor.user_id, operation, operationId:request.operation_id});
for (const state of input.field.values) {
  const request = envelope(state);
  const outcome = await invoker.invokeMutation(request, identity);
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, 'committed');
  assert.equal(outcome.result.result, true, 'every owning enum case executes the actual boolean scenario');
  const saved = await receipt(request);
  assert.equal(saved.outcome.status, 'committed');
  assert.equal(saved.outcome.result, true);
}
const invalid = envelope('not-a-delivery-status');
const rejected = await invoker.invokeMutation(invalid, identity);
assert.ok('error' in rejected, JSON.stringify(rejected));
assert.equal(rejected.error.code, 'validation', 'nonmember fails input decoding before the authored true result');
const saved = await receipt(invalid);
assert.equal(saved.outcome.status, 'rejected');
assert.equal(saved.outcome.code, 'validation');
assert.deepEqual(saved.resolvedDefaults, {});
console.log(JSON.stringify({consumer:'actual generated source → installed canonical CF/State Memory enum codec',
  acceptedCases:input.field.values, nonmember:'validation', deliveryObservation:false}));
