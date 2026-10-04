/**
 * Wire contract conformance (S1/B0): envelope, error, upload, and action
 * fixtures satisfy the wire.ts shapes and their documented transport rules.
 * Runtime assertions here check fixture content only; dispatch behavior
 * lands with the S3+ implementations.
 *
 * NOTE: relative contract import is temporary until L7 join J1 assembles
 * @canlang/contracts; then this becomes a workspace package import.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BUSINESS_ERROR_CODES,
  BUSINESS_ERROR_HTTP_STATUS,
  CAN_FILE_SCHEMA_FORMAT,
  COLLECTION_DEFAULT_LIMIT,
  COLLECTION_MAX_LIMIT,
  CSV_IMPORT_MAX_BYTES,
  CSV_IMPORT_MAX_ROWS,
  DEFAULT_UPLOAD_MAX_BYTES,
  DEFAULT_UPLOAD_TYPES,
  FILE_TRANSFER_META_KEY,
  PAGE_MAX_RECORDS,
  PAGE_MAX_RESPONSE_BYTES,
  WIRE_CONTRACT_VERSION,
} from '../../contracts/src/wire.js';
import type {
  ActionHandleInvocation,
  BusinessError,
  BusinessErrorCode,
  MutationEnvelope,
  MutationRef,
  MutationResult,
  UploadFinalizeResponse,
  UploadIntentRequest,
  UploadIntentResponse,
} from '../../contracts/src/wire.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('contract version is pinned', () => {
  assert.equal(WIRE_CONTRACT_VERSION, 1);
});

test('business error codes map to exactly one HTTP status each', () => {
  assert.deepEqual([...BUSINESS_ERROR_CODES], [
    'validation',
    'forbidden',
    'not_found',
    'conflict',
    'rule_failed',
    'busy',
    'limit',
    'delivery_unknown',
  ]);
  const codes = Object.keys(BUSINESS_ERROR_HTTP_STATUS);
  assert.deepEqual([...codes].sort(), [...BUSINESS_ERROR_CODES].sort());
  for (const code of BUSINESS_ERROR_CODES) {
    const status: number = BUSINESS_ERROR_HTTP_STATUS[code];
    assert.ok(Number.isInteger(status) && status >= 400 && status < 600);
  }
  // Spot-check the lane-06 authored mapping.
  const expected: Record<BusinessErrorCode, number> = {
    validation: 400,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    rule_failed: 422,
    busy: 503,
    limit: 429,
    delivery_unknown: 502,
  };
  assert.deepEqual(BUSINESS_ERROR_HTTP_STATUS, expected);
});

test('pinned transport bounds match DESIGN', () => {
  assert.equal(COLLECTION_DEFAULT_LIMIT, 25);
  assert.equal(COLLECTION_MAX_LIMIT, 100);
  assert.equal(PAGE_MAX_RECORDS, 500);
  assert.equal(PAGE_MAX_RESPONSE_BYTES, 1048576);
  assert.deepEqual([...DEFAULT_UPLOAD_TYPES], [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'text/plain',
  ]);
  assert.equal(DEFAULT_UPLOAD_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(CSV_IMPORT_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(CSV_IMPORT_MAX_ROWS, 1000);
  assert.equal(FILE_TRANSFER_META_KEY, 'org.canlang/fileTransfer');
  assert.equal(CAN_FILE_SCHEMA_FORMAT, 'can-file');
});

test('mutation envelope fixture is canonical', () => {
  const data = fixture('mutation-envelope.json') as {
    envelope: MutationEnvelope;
    result: MutationResult;
  };
  const envelope: MutationEnvelope = data.envelope;
  assert.match(envelope.operation_id, UUID_V7);
  assert.ok(!('actor' in envelope.inputs) && !('team' in envelope.inputs));
  const record = envelope.inputs['record'] as MutationRef;
  assert.equal(typeof record.id, 'string');
  // Versions travel as canonical decimal strings, never JSON numbers.
  assert.equal(typeof record.version, 'string');
  assert.match(record.version, /^[0-9]+$/);

  const result: MutationResult = data.result;
  assert.equal(result.operation_id, envelope.operation_id);
  assert.ok(result.status === 'committed' || result.status === 'replayed');
});

test('business error fixture matches its HTTP status', () => {
  const data = fixture('business-error.json') as {
    error: BusinessError;
    http_status: number;
  };
  const error: BusinessError = data.error;
  assert.ok((BUSINESS_ERROR_CODES as readonly string[]).includes(error.code));
  assert.equal(BUSINESS_ERROR_HTTP_STATUS[error.code], data.http_status);
  for (const field of error.fields ?? []) {
    assert.ok(field.path.startsWith('/'));
    assert.ok(field.message.length > 0);
  }
  // Safe envelope: no secret-bearing members anywhere in the JSON.
  const forbidden = ['stack', 'sql', 'token', 'secret', 'password', 'cookie', 'credential'];
  const keys: string[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        keys.push(key.toLowerCase());
        collect(item);
      }
    }
  };
  collect(data.error);
  for (const key of keys) {
    assert.ok(
      !forbidden.some((name) => key.includes(name)),
      `secret-bearing key: ${key}`,
    );
  }
});

test('upload intent fixture follows the three-step bridge', () => {
  const data = fixture('upload-intent.json') as {
    fixture_now: string;
    request: UploadIntentRequest;
    response: UploadIntentResponse;
    finalized: UploadFinalizeResponse;
  };
  const request: UploadIntentRequest = data.request;
  assert.match(request.size, /^[0-9]+$/);
  assert.ok(request.field.startsWith('/'));
  // The selected file slot is absent from the preparatory arguments.
  assert.ok(!('receipt' in request.arguments) && !('file' in request.arguments));

  const response: UploadIntentResponse = data.response;
  for (const url of [response.content, response.finalize]) {
    assert.ok(url.startsWith('https://'));
    assert.ok(!url.includes('credential') && !url.includes('signature='));
  }
  assert.ok(Date.parse(data.fixture_now) > 0);
  assert.ok(Date.parse(response.expires_at) > Date.parse(data.fixture_now));

  const finalized: UploadFinalizeResponse = data.finalized;
  assert.ok(finalized.file.length > 0);
});

test('action handle fixture omits protected record inputs', () => {
  const data = fixture('action-handle.json') as {
    invocation: ActionHandleInvocation;
  };
  const invocation: ActionHandleInvocation = data.invocation;
  assert.equal(invocation.action_handle.kind, 'action_handle');
  assert.match(invocation.operation_id, UUID_V7);
  assert.ok(invocation.action_handle.revision.length > 0);
  // No record-typed input may ride a handle invocation, at any depth.
  const checkNoRecord = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => checkNoRecord(item, `${path}[${index}]`));
    } else if (typeof value === 'object' && value !== null) {
      assert.ok(!('id' in value), `record-typed input at ${path}`);
      for (const [key, item] of Object.entries(value)) {
        checkNoRecord(item, `${path}.${key}`);
      }
    }
  };
  checkNoRecord(invocation.inputs, '$inputs');
});
