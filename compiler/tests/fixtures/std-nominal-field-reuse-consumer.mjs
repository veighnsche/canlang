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
const {datetime, compareInstant, equalValue} = await load('@canlang/cloudflare/runtime/stdlib');
const {makeDatetime, isDatetime, encodeValue, decodeValue} = await load('@canlang/stdlib');
const canonical = '2026-10-01T00:00:00.000Z';
const instant = datetime('2026-10-01T02:00:00+02:00');
assert.equal(Object.isFrozen(instant), true);
assert.equal(instant.kind, 'datetime');
assert.equal(typeof instant.ms, 'bigint');
assert.equal(compareInstant(instant, makeDatetime(instant.ms)), 0);
assert.equal(equalValue('datetime', instant, decodeValue('datetime', canonical)), true);
assert.equal(encodeValue('datetime', instant), canonical);
for (const [ms, wire] of [
  [-62135596800000n, '0001-01-01T00:00:00.000Z'],
  [253402300799999n, '9999-12-31T23:59:59.999Z'],
]) {
  assert.equal(encodeValue('datetime', makeDatetime(ms)), wire);
  assert.equal(decodeValue('datetime', wire).ms, ms);
}
for (const ms of [-62135596800001n, 253402300800000n]) {
  assert.throws(() => makeDatetime(ms));
  const shapeOnly = Object.freeze({kind:'datetime', ms});
  assert.equal(isDatetime(shapeOnly), true, 'shape guard does not establish range provenance');
  assert.throws(() => encodeValue('datetime', shapeOnly));
}
for (const malformed of [{kind:'date', ms:instant.ms}, {kind:'datetime', ms:0}, {ms:instant.ms}]) {
  assert.throws(() => encodeValue('datetime', malformed));
  assert.throws(() => compareInstant(malformed, instant));
  assert.throws(() => equalValue('datetime', malformed, instant));
}
const datetimeOperation = 'NominalFieldReuse.received_equal';
const datetimeInput = artifact.operations.find(item => item.name === datetimeOperation).inputs.fields[0];
assert.equal(datetimeInput.name, 'received');
assert.equal(datetimeInput.field.kind, 'datetime');
const datetimeEnvelope = received => ({operation:datetimeOperation,
  operation_id:uuidv7(FIXED_NOW, ++sequence), inputs:{received}});
for (const [wire, expected] of [
  [canonical, true], ['2026-10-01T00:00:00.001Z', false],
  ['0001-01-01T00:00:00.000Z', false], ['9999-12-31T23:59:59.999Z', false],
]) {
  const outcome = await invoker.invokeMutation(datetimeEnvelope(wire), identity);
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, 'committed');
  assert.equal(outcome.result.result, expected, 'untouched emitted typed datetime equality executes');
}
for (const wire of [
  '2026-10-01T00:00:00Z', '2026-10-01T02:00:00.000+02:00',
  '0000-01-01T00:00:00.000Z', '10000-01-01T00:00:00.000Z',
  '2026-02-30T00:00:00.000Z', {kind:'datetime', ms:'0'}, 0, null,
]) {
  assert.throws(() => decodeValue('datetime', wire));
  const outcome = await invoker.invokeMutation(datetimeEnvelope(wire), identity);
  assert.ok('error' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.error.code, 'validation');
}
console.log(JSON.stringify({consumer:'actual generated source → installed canonical CF/State Memory enum and datetime codecs',
  acceptedCases:input.field.values, nonmember:'validation', datetimeField:'IncomingEmail.received',
  datetimeComparison:[true,false], canonicalDatetimeWire:canonical, deliveryObservation:false}));
