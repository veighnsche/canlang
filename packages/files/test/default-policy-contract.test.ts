import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_UPLOAD_MAX_BYTES, DEFAULT_UPLOAD_TYPES } from '@canlang/contracts';
import { DEFAULT_FILE_POLICY } from '../src/upload/index.js';

it('pins the files default policy to the wire upload defaults (L4 S8b)', () => {
  assert.deepEqual(DEFAULT_FILE_POLICY, {
    types: [...DEFAULT_UPLOAD_TYPES],
    maxBytes: DEFAULT_UPLOAD_MAX_BYTES,
  });
});
