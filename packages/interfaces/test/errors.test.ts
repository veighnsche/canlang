/**
 * S3 error-envelope tests: safe messages, envelope constructors, transport
 * projections, redaction, and error logging.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_ERROR_CODES, BUSINESS_ERROR_HTTP_STATUS } from '@canlang/contracts';
import type { BusinessError, BusinessErrorCode } from '@canlang/contracts';
import type { Logger, LogLevel } from '../src/ports.js';
import {
  PUBLIC_ERROR_MESSAGES,
  fieldError,
  isBusinessErrorCode,
} from '../src/errors/safe.js';
import {
  buildBusinessError,
  fromUnknown,
  httpStatusFor,
  toHttpResponse,
  toMcpError,
} from '../src/errors/envelope.js';
import { REDACTED, SECRET_KEY_PATTERN, redactForLog } from '../src/errors/redact.js';
import {
  createConsoleLogger,
  incidentId,
  logBusinessError,
  logInternalError,
} from '../src/errors/logging.js';

test('PUBLIC_ERROR_MESSAGES covers all 8 codes with generic safe text', () => {
  assert.equal(BUSINESS_ERROR_CODES.length, 8);
  const banned = /sql|stack|trace|token|password/i;
  for (const code of BUSINESS_ERROR_CODES) {
    const message: string = PUBLIC_ERROR_MESSAGES[code];
    assert.equal(typeof message, 'string');
    assert.ok(message.length > 0, `${code} has non-empty text`);
    assert.ok(!banned.test(message), `${code} leaks internals: ${message}`);
  }
  // Exact key set: one message per code, no extras.
  assert.deepEqual(Object.keys(PUBLIC_ERROR_MESSAGES).sort(), [...BUSINESS_ERROR_CODES].sort());
});

test('fieldError builds pointers and rejects non-pointer paths', () => {
  assert.deepEqual(fieldError('/changes/title', 'required', 'Title is required.'), {
    path: '/changes/title',
    code: 'required',
    message: 'Title is required.',
  });
  assert.throws(() => fieldError('title', 'required', 'Title is required.'), Error);
  assert.throws(() => fieldError('', 'required', 'Title is required.'), Error);
});

test('isBusinessErrorCode narrows the closed code set', () => {
  for (const code of BUSINESS_ERROR_CODES) {
    assert.equal(isBusinessErrorCode(code), true);
  }
  assert.equal(isBusinessErrorCode('exploded'), false);
  assert.equal(isBusinessErrorCode(''), false);
  assert.equal(isBusinessErrorCode(undefined), false);
  assert.equal(isBusinessErrorCode(null), false);
  assert.equal(isBusinessErrorCode(42), false);
  assert.equal(isBusinessErrorCode({}), false);
});

test('buildBusinessError defaults message and retryable per code', () => {
  const validation = buildBusinessError('validation');
  assert.equal(validation.code, 'validation');
  assert.equal(validation.message, PUBLIC_ERROR_MESSAGES['validation']);
  assert.equal(validation.retryable, false);
  assert.ok(!('operation_id' in validation));
  assert.ok(!('fields' in validation));

  // Only busy/delivery_unknown default to retryable.
  for (const code of BUSINESS_ERROR_CODES) {
    const error = buildBusinessError(code);
    const expected = code === 'busy' || code === 'delivery_unknown';
    assert.equal(error.retryable, expected, code);
  }
});

test('buildBusinessError honors explicit overrides', () => {
  const fields = [fieldError('/name', 'required', 'Name is required.')];
  const error = buildBusinessError('conflict', 'Custom safe text.', {
    operation_id: 'op-1',
    fields,
    retryable: true,
  });
  assert.equal(error.message, 'Custom safe text.');
  assert.equal(error.operation_id, 'op-1');
  assert.deepEqual(error.fields, fields);
  assert.equal(error.retryable, true);

  // Explicit false wins even for default-retryable codes.
  assert.equal(buildBusinessError('busy', undefined, { retryable: false }).retryable, false);
});

test('httpStatusFor matches the contract table for all codes', () => {
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
  for (const code of BUSINESS_ERROR_CODES) {
    assert.equal(httpStatusFor(code), BUSINESS_ERROR_HTTP_STATUS[code]);
  }
});

test('toHttpResponse carries status with the BusinessError body', () => {
  const error = buildBusinessError('not_found', undefined, { operation_id: 'op-2' });
  const response = toHttpResponse(error);
  assert.equal(response.status, 404);
  assert.equal(response.body, error);
  assert.deepEqual(response.body, {
    code: 'not_found',
    message: PUBLIC_ERROR_MESSAGES['not_found'],
    operation_id: 'op-2',
    retryable: false,
  });
});

test('toMcpError sets isError with code-prefixed text', () => {
  const error = buildBusinessError('forbidden');
  const mcp = toMcpError(error);
  assert.equal(mcp.isError, true);
  assert.equal(mcp.content.length, 1);
  const block = mcp.content[0];
  assert.ok(block !== undefined);
  assert.equal(block.type, 'text');
  assert.equal(block.text, `forbidden: ${PUBLIC_ERROR_MESSAGES['forbidden']}`);
  assert.equal(mcp.structuredContent, error);
});

test('toMcpError bounds field details to 5 plus a count note', () => {
  const fields = [0, 1, 2, 3, 4, 5].map((n) =>
    fieldError(`/f${n}`, 'bad', `field ${n} is bad`),
  );
  const mcp = toMcpError(buildBusinessError('validation', undefined, { fields }));
  const block = mcp.content[0];
  assert.ok(block !== undefined);
  // First five fields inline.
  for (const n of [0, 1, 2, 3, 4]) {
    assert.ok(block.text.includes(`/f${n}: field ${n} is bad`), block.text);
  }
  // Sixth field replaced by an ellipsis count note.
  assert.ok(!block.text.includes('/f5'), block.text);
  assert.ok(block.text.includes('…'), block.text);
  assert.ok(block.text.includes('1 more'), block.text);
});

test('fromUnknown maps throws to rule_failed without leaking detail', () => {
  const secret = 'hunter2-db-password';
  const error = fromUnknown(new Error(`db exploded: password=${secret}`));
  assert.equal(error.code, 'rule_failed');
  assert.equal(error.message, PUBLIC_ERROR_MESSAGES['rule_failed']);
  assert.equal(error.retryable, false);
  assert.ok(!JSON.stringify(error).includes(secret));
  assert.ok(!JSON.stringify(error).includes('db exploded'));

  // Non-Error throws map the same way; operation_id still attaches.
  const thrown = fromUnknown({ weird: 'object' }, { operation_id: 'op-3' });
  assert.equal(thrown.code, 'rule_failed');
  assert.equal(thrown.operation_id, 'op-3');
  const business: BusinessError = thrown;
  void business;
});

test('redactForLog replaces secret-keyed members without descent', () => {
  assert.ok(SECRET_KEY_PATTERN.test('authToken'));
  assert.ok(SECRET_KEY_PATTERN.test('session'));
  assert.ok(!SECRET_KEY_PATTERN.test('name'));

  const input = {
    user: 'ada',
    authToken: 'tok-123',
    nested: { name: 'ada', password: 'pw-123' },
    // Secret key at the top: whole subtree replaced, no descent.
    session: { id: 's-1', cookie: 'c-1' },
  };
  assert.deepEqual(redactForLog(input), {
    user: 'ada',
    authToken: REDACTED,
    nested: { name: 'ada', password: REDACTED },
    session: REDACTED,
  });
  // Input untouched (deep clone, not mutation).
  assert.equal(input.session.cookie, 'c-1');
});

test('redactForLog traverses arrays and passes primitives through', () => {
  assert.equal(redactForLog('plain'), 'plain');
  assert.equal(redactForLog(42), 42);
  assert.equal(redactForLog(null), null);
  assert.equal(redactForLog(undefined), undefined);
  assert.deepEqual(redactForLog([{ password: 'x' }, 'ok', 7]), [
    { password: REDACTED },
    'ok',
    7,
  ]);
});

test('redactForLog replaces circular refs and honors the depth cap', () => {
  const circular: Record<string, unknown> = { name: 'loop' };
  circular['self'] = circular;
  assert.deepEqual(redactForLog(circular), { name: 'loop', self: '[circular]' });

  const deep = { a: { b: { c: 'too deep' } } };
  assert.deepEqual(redactForLog(deep, { maxDepth: 2 }), { a: { b: '[depth]' } });
  assert.deepEqual(redactForLog(deep), { a: { b: { c: 'too deep' } } });
});

test('redactForLog never throws on hostile nodes', () => {
  const hostile = {
    get boom(): unknown {
      throw new Error('getter exploded');
    },
  };
  assert.doesNotThrow(() => redactForLog({ nested: hostile }));
  assert.deepEqual(redactForLog({ nested: hostile }), { nested: '[unserializable]' });
});

interface RecordedCall {
  level: LogLevel;
  message: string;
  fields: Record<string, unknown> | undefined;
}

function stubLogger(calls: RecordedCall[]): Logger {
  return {
    log(level, message, fields) {
      calls.push({ level, message, fields });
    },
  };
}

test('logBusinessError logs at info with no stack', () => {
  const calls: RecordedCall[] = [];
  const error = buildBusinessError('conflict', undefined, { operation_id: 'op-9' });
  logBusinessError(stubLogger(calls), error, { route: '/todos' });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.level, 'info');
  assert.ok(call.message.includes('conflict'));
  assert.equal(call.fields?.['code'], 'conflict');
  assert.equal(call.fields?.['operation_id'], 'op-9');
  assert.equal(call.fields?.['route'], '/todos');
  assert.ok(!('stack' in (call.fields ?? {})));
});

test('logInternalError returns an 8-hex id and logs redacted fields', () => {
  const calls: RecordedCall[] = [];
  const secret = 'sup3r-s3cret-cookie';
  const id = logInternalError(
    stubLogger(calls),
    { db: 'main', password: secret },
    { session: { cookie: secret }, route: '/todos' },
  );
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.level, 'error');
  assert.equal(call.fields?.['incident_id'], id);
  const json = JSON.stringify(call.fields);
  assert.ok(!json.includes(secret), json);
  assert.equal(call.fields?.['route'], '/todos');
});

test('incidentId returns 8 hex chars and createConsoleLogger writes JSON lines', () => {
  assert.match(incidentId(), /^[0-9a-f]{8}$/);
  assert.notEqual(incidentId(), incidentId());

  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    const logger = createConsoleLogger();
    logger.log('info', 'hello', { route: '/x' });
    logger.log('error', 'boom', { incident_id: 'abc' });
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  assert.equal(logs.length, 1);
  assert.equal(errors.length, 1);
  assert.deepEqual(JSON.parse(logs[0] ?? '{}'), {
    route: '/x',
    level: 'info',
    message: 'hello',
  });
  assert.deepEqual(JSON.parse(errors[0] ?? '{}'), {
    incident_id: 'abc',
    level: 'error',
    message: 'boom',
  });
});
