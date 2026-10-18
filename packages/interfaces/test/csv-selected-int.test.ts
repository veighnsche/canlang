// R2 selected int consumer: duplicateKey consumes the genuine native int
// producer at explicit opt-in selection. Leading zeros/-0 normalize duplicate
// identity only; raw row spellings, mapping, consent and invocation are
// preserved; full-domain TS route handles non-ASCII; native failure never
// retries or falls back.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ARTIFACT_VERSION } from '@canlang/contracts';
import { SchemaError, ValueError } from '@canlang/values';
import { selectSelectedIntBackend } from '@canlang/values/bindings/backend';
import { bootstrapWasm } from '@canlang/values/bindings/bootstrap';
import { catalogFromArtifactOperations } from '../src/http/operations.js';
import { reviewCsvCandidates } from '../src/http/csv.js';

const operation = 'Data.Row.put';
const owner = catalogFromArtifactOperations({ artifact_version: ARTIFACT_VERSION, operations: [{
  name: operation, kind: 'create', description: '',
  inputs: { fields: [{ name: 'count', field: { kind: 'integer' }, required: false }] },
}] });

function review(cells: string[][]) {
  return reviewCsvCandidates({ operation, shape: owner.shapeFor(operation)!, derived: owner.derivedFor(operation)!,
    principal: 'viewer', header: ['count'], rows: cells.map((row) => ({ cells: row, malformed: false })) });
}

const wasmBytes = () =>
  new Uint8Array(readFileSync(new URL('../../../values/bindings/generated/values_semantics_bg.wasm', import.meta.url)));

test('selected int consumer normalizes identity, preserves raw rows', async () => {
  selectSelectedIntBackend(bootstrapWasm(wasmBytes()));
  try {
    const result = await review([['0042'], ['42'], ['-0'], ['0'], ['9223372036854775807'], ['-9223372036854775808']]);
    assert.deepEqual(result.rows.map((row) => row.status),
      ['valid', 'duplicate', 'valid', 'duplicate', 'valid', 'valid']);
    assert.equal(result.rows[1]?.duplicate_of, 0);
    assert.equal(result.rows[3]?.duplicate_of, 2);
    // Raw row spellings untouched; only duplicate identity normalized.
    assert.equal(result.rows[0]?.inputs['count'], '0042');
    assert.equal(result.rows[1]?.inputs['count'], '42');
    assert.equal(result.rows[2]?.inputs['count'], '-0');
  } finally {
    selectSelectedIntBackend(null);
  }
});

test('selected int consumer preserves binding verdicts for bad cells', async () => {
  selectSelectedIntBackend(bootstrapWasm(wasmBytes()));
  try {
    const result = await review([['12a'], ['9223372036854775808'], ['12é'], ['']]);
    assert.deepEqual(result.rows.map((row) => row.status), ['invalid', 'invalid', 'invalid', 'valid']);
    // Existing binding messages preserved verbatim; no crash, no fallback.
    assert.match(result.rows[0]?.error?.message ?? '', /canonical digit strings/);
    assert.match(result.rows[1]?.error?.message ?? '', /exceeds the int64 range/);
    assert.match(result.rows[2]?.error?.message ?? '', /canonical digit strings/);
  } finally {
    selectSelectedIntBackend(null);
  }
});

test('selected int consumer maps native failure without retry or fallback', async () => {
  selectSelectedIntBackend({ name: 'wasm', call: () => {
    throw new SchemaError([{ path: [], code: 'format', message: 'int is malformed' }]);
  } });
  try {
    const result = await review([['42']]);
    assert.deepEqual(result.rows.map((row) => row.status), ['invalid']);
    // Existing mechanism maps any SchemaError to a validation verdict using
    // its message (native and legacy share the default SchemaError message).
    assert.match(result.rows[0]?.error?.message ?? '', /schema validation failed with 1 violation/);
  } finally {
    selectSelectedIntBackend(null);
  }
  selectSelectedIntBackend({ name: 'wasm', call: () => {
    throw new ValueError('invalid-construction', 'native transport fault on decode-value: boom');
  } });
  try {
    await assert.rejects(() => review([['42']]), /native transport fault/);
  } finally {
    selectSelectedIntBackend(null);
  }
});

test('int consumer without opt-in keeps the legacy TS route', async () => {
  selectSelectedIntBackend(null);
  const result = await review([['0042'], ['42']]);
  assert.deepEqual(result.rows.map((row) => row.status), ['valid', 'duplicate']);
  assert.equal(result.rows[0]?.inputs['count'], '0042');
});
