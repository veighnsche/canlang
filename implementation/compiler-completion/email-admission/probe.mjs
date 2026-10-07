import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { decodeValue, encodeValue } from '@canlang/values';

const root = resolve(process.argv[2] ?? '.');
const packet = resolve(root, 'implementation/compiler-completion/email-admission');
const compiler = resolve(process.argv[3] ?? '/private/tmp/can-email-admission-target/debug/can');
const vectors = JSON.parse(readFileSync(resolve(packet, 'vectors.json'), 'utf8'));
const capture = (fn, value) => {
  try { return { accepted: true, value: fn('email', value) }; }
  catch (error) { return { accepted: false, error: { name: error.name, code: error.code, message: error.message, violations: error.violations } }; }
};
const outcome = (direction, value, expected) => {
  const result = capture(direction === 'decode' ? decodeValue : encodeValue, value);
  assert.equal(result.accepted, expected, `${direction}: ${JSON.stringify(value)}`);
  if (expected) assert.equal(result.value, value, direction);
  else if (direction === 'encode') { assert.equal(result.error.name, 'ValueError'); assert.equal(result.error.code, 'invalid-construction'); }
  else { assert.equal(result.error.name, 'SchemaError'); assert.deepEqual(result.error.violations.map(v => ({path:v.path,code:v.code})), [{path:[],code:'format'}]); }
  return result;
};
const observed = [];
for (const test of vectors) {
  const entry = { id: test.id, value: test.value, expected: test.expected,
    decode: outcome('decode', test.value, test.expected), encode: outcome('encode', test.value, test.expected) };
  const directory = resolve(packet, 'fixtures', test.id);
  mkdirSync(directory, { recursive: true });
  const source = resolve(directory, 'value.can');
  const text = `app T\nGiven\n M { address:email=${JSON.stringify(test.value)} }\nWhen\nThen\n`;
  writeFileSync(source, text);
  entry.sourceHash = createHash('sha256').update(text).digest('hex');
  for (const command of ['check', 'compile']) {
    const args = [command, '--format=json', '--catalog', resolve(root, 'packages/values/dist/catalog.json'), source];
    const run = spawnSync(compiler, args, { cwd: root, encoding: 'utf8', timeout:10000, maxBuffer:8*1024*1024 });
    assert.ifError(run.error);
    writeFileSync(resolve(directory, `${command}.stdout`), run.stdout);
    writeFileSync(resolve(directory, `${command}.stderr`), run.stderr);
    entry[command] = { command:[compiler,...args], exit:run.status, accepted:run.status === 0 };
    assert.equal(entry[command].accepted, entry.check.accepted, `${test.id}: checker and compile must share admission`);
    if (command === 'compile' && run.status === 0) {
      const artifact = JSON.parse(run.stdout);
      assert.equal(artifact.artifact_version, 1, test.id);
      assert.ok(artifact.modules.length > 0, test.id);
      const field = artifact.models.find(m => m.name === 'T.M').fields.find(f => f.name === 'address');
      assert.equal(field.default.value, test.value, `${test.id}: literal metadata`);
      for (const module of artifact.modules) {
        const path = resolve(directory, module.path); mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, module.js);
      }
      try {
        const actualModule = await import(pathToFileURL(resolve(directory, artifact.modules[0].path)).href);
        const actual = actualModule.appDefinition.models['T.M'].fields.address.default;
        assert.equal(actual, test.value, `${test.id}: executed metadata literal`);
        entry.generated = { imported:true, value:actual, decode:capture(decodeValue, actual), encode:capture(encodeValue, actual) };
        assert.equal(entry.generated.decode.accepted, test.expected);
        assert.equal(entry.generated.encode.accepted, test.expected);
      } catch (error) {
        entry.generated = { imported:false, error:{name:error.name, code:error.code, message:error.message} };
      }
    }
  }
  entry.mismatch = entry.check.accepted !== test.expected;
  observed.push(entry);
}
const summary = { vectors:vectors.length, publicDirections:2*vectors.length,
  publicAccepted:vectors.filter(v=>v.expected).length, compilerAccepted:observed.filter(v=>v.check.accepted).length,
  mismatches:observed.filter(v=>v.mismatch).map(v=>({id:v.id,expected:v.expected,compilerAccepted:v.check.accepted})),
  generated:observed.filter(v=>v.generated).length, generatedImported:observed.filter(v=>v.generated?.imported).length,
  node:process.version, icu:process.versions.icu, compiler, compilerHash:createHash('sha256').update(readFileSync(compiler)).digest('hex'),
  limits:'Current CLI and actual installed public values/UI exports; metadata execution only, not application invocation, DNS, deliverability or auth.' };
writeFileSync(resolve(packet, 'baseline-observations.json'), JSON.stringify(observed,null,2)+'\n');
writeFileSync(resolve(packet, 'baseline-summary.json'), JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
