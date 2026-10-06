import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeValue, encodeValue, app_url } from '@canlang/values';
const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
const results = [];
for (const test of vectors) {
  if (test.expected) {
    const decoded = decodeValue('url', test.value);
    const encoded = encodeValue('url', test.value);
    const roundtrip = encodeValue('url', decoded);
    assert.equal(decoded, test.value, test.id);
    assert.equal(encoded, test.value, test.id);
    assert.equal(roundtrip, test.value, test.id);
    results.push({id:test.id, valid:true, decoded, encoded, roundtrip});
  } else {
    let decodeError, encodeError;
    assert.throws(() => decodeValue('url', test.value), error => {
      decodeError = {name:error.name, kind:error.kind, violations:error.violations};
      return error.name === 'SchemaError' && error.kind === 'schema'
        && error.violations[0].code === 'format';
    }, test.id);
    assert.throws(() => encodeValue('url', test.value), error => {
      encodeError = {name:error.name, kind:error.kind, code:error.code};
      return error.name === 'ValueError' && error.code === 'invalid-construction';
    }, test.id);
    results.push({id:test.id, valid:false, decodeError, encodeError});
  }
}
// Ordinary credentials are valid URL values; app_url's trusted origin rejects them.
assert.equal(decodeValue('url', 'https://user:pass@example.com'), 'https://user:pass@example.com');
assert.throws(() => app_url('/a', 'https://user:pass@example.com'), error => error.code === 'invalid-construction');
assert.throws(() => app_url('/a', 'https://example.com?query=1'), error => error.code === 'invalid-construction');
assert.equal(app_url('/a', 'HTTPS://EXAMPLE.COM/base'), 'https://example.com/base/a');
const entry = import.meta.resolve('@canlang/values');
console.log(JSON.stringify({node:process.version, icu:process.versions.icu, entry,
  entry_sha256:createHash('sha256').update(readFileSync(fileURLToPath(entry))).digest('hex'), results,
  trusted_origin_witnesses:3}, null, 2));
