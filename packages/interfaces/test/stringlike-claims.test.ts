import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkArtifactOperations,
  checkedToMcpInputSchema,
} from '../src/mcp/schemas.js';
import type { ArtifactOperationSlice } from '../src/mcp/schemas.js';

/* Verbatim emission shape: a string field carrying a validated string-like claim. */
const STRINGLIKE_CREATE = {
  "name": "Shop.Site.create",
  "kind": "create",
  "description": "",
  "inputs": {"fields": [
    {"name": "currency", "field": {"kind": "string"}, "valueType": "currency", "required": true},
    {"name": "timezone", "field": {"kind": "string"}, "valueType": "timezone", "required": true},
    {"name": "locale", "field": {"kind": "string"}, "valueType": "locale", "required": false},
    {"name": "homepage", "field": {"kind": "string"}, "valueType": "url", "required": false},
  ]},
};

test('validated string-like claims admit string inputs', () => {
  const slice = { artifact_version: 1, operations: [STRINGLIKE_CREATE] } as unknown as ArtifactOperationSlice;
  const checked = checkArtifactOperations(slice)[0]!;
  const mcp = checkedToMcpInputSchema(checked);
  for (const field of mcp.fields) {
    assert.deepEqual(field.field, { kind: 'string' });
  }
});

test('unknown valueType claims still refuse', () => {
  const bad = {
    "name": "Shop.Site.create",
    "kind": "create",
    "description": "",
    "inputs": {"fields": [
      {"name": "currency", "field": {"kind": "string"}, "valueType": "frobnicate", "required": true},
    ]},
  };
  const slice = { artifact_version: 1, operations: [bad] } as unknown as ArtifactOperationSlice;
  assert.throws(() => checkArtifactOperations(slice), /scalar profile|checked type/);
});
