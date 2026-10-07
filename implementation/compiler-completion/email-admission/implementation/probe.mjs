import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { decodeValue, encodeValue } from '@canlang/values';

const root = resolve(process.argv[2] ?? '.');
const packet = resolve(root, 'implementation/compiler-completion/email-admission');
const compiler = resolve(process.argv[3]);
const output = resolve(process.argv[4]);
mkdirSync(output, {recursive:true});
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
assert.equal(vectors.length, 113);
assert.equal(vectors.filter(test => test.expected).length, 29);
assert.equal(new Set(vectors.map(test => test.id)).size, 113);
const observed = [];
for (const test of vectors) {
  const entry = { id: test.id, value: test.value, expected: test.expected,
    decode: outcome('decode', test.value, test.expected), encode: outcome('encode', test.value, test.expected) };
  const directory = resolve(output, 'fixtures', test.id);
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
    assert.equal(entry[command].accepted, test.expected, `${test.id}: ${command} admission`);
    if (!test.expected || command === 'check') {
      const report = JSON.parse(run.stdout);
      assert.equal(report.complete, true, test.id);
      assert.equal(report.omitted, 0, test.id);
      assert.equal(report.diagnostics.length, test.expected ? 0 : 1, test.id);
      assert.equal(report.artifact_version, undefined, `${test.id}: no rejected artifact`);
      assert.equal(report.modules, undefined, `${test.id}: no rejected modules`);
      if (!test.expected) {
        const diagnostic = report.diagnostics[0];
        assert.equal(diagnostic.code, 'E3001', test.id);
        assert.equal(diagnostic.severity, 'error', test.id);
        const literal = JSON.stringify(test.value);
        const start = Buffer.byteLength(text.slice(0, text.indexOf(literal)));
        assert.deepEqual(diagnostic.primary, {file:0, start, end:start + Buffer.byteLength(literal)}, `${test.id}: literal anchor`);
      }
    }
    if (command === 'compile' && run.status === 0) {
      const artifact = JSON.parse(run.stdout);
      assert.equal(artifact.artifact_version, 1, test.id);
      assert.ok(artifact.modules.length > 0, test.id);
      const field = artifact.models.find(m => m.name === 'T.M').fields.find(f => f.name === 'address');
      assert.equal(field.default.value, test.value, `${test.id}: literal metadata`);
      for (const module of artifact.modules) {
        const path = resolve(directory, module.path); mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, module.js);
      }
      {
        const actualModule = await import(pathToFileURL(resolve(directory, artifact.modules[0].path)).href);
        const actual = actualModule.appDefinition.models['T.M'].fields.address.default;
        assert.equal(actual, test.value, `${test.id}: executed metadata literal`);
        entry.generated = { imported:true, value:actual, decode:capture(decodeValue, actual), encode:capture(encodeValue, actual) };
        assert.equal(entry.generated.decode.accepted, test.expected);
        assert.equal(entry.generated.encode.accepted, test.expected);
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
  limits:'Current CLI, generated metadata modules and actual installed public values exports; metadata execution only, not application invocation, DNS, deliverability or auth.' };
writeFileSync(resolve(output, 'observations.json'), JSON.stringify(observed,null,2)+'\n');
writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
