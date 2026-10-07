import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearerToken, parseObjectBody } from '../src/internal/input-admission.js';

// Each owner keeps its authentication/admission response policy; these pin only exact leaves.
test('Bearer extraction preserves one receiver-bound header read and lexical cases', () => {
  const cases: Array<[string | null, string | null]> = [
    [null, null], ['', null], ['Bearer', null], ['Bearer ', null], ['Basic token', null],
    ['Bearer\ttoken', null], [' bEaReR   token  ', 'token'], ['Bearer token more', 'token more'],
  ];
  for (const [header, expected] of cases) {
    let reads = 0;
    const headers = { get(name: string) { assert.equal(this, headers); assert.equal(name, 'authorization'); reads++; return header; } };
    assert.equal(bearerToken({ headers } as unknown as Request), expected);
    assert.equal(reads, 1);
  }
  const error = new Error('header getter');
  assert.throws(() => bearerToken({ headers: { get() { throw error; } } } as unknown as Request), (err) => err === error);
});

test('object body checks media type before reading body; retains parser and shape errors', async () => {
  const trace: string[] = [];
  const headers = { get(name: string) { assert.equal(this, headers); trace.push(name); return 'text/plain'; } };
  const request = { headers, get body() { trace.push('body'); throw new Error('body must not read'); } } as unknown as Request;
  await assert.rejects(parseObjectBody(request), /Unsupported content type\./);
  assert.deepEqual(trace, ['content-type']);
  const own = await parseObjectBody(new Request('https://x.invalid', { method: 'POST', headers: { 'content-type': ' APPLICATION/JSON ; charset=utf-8' }, body: '{"__proto__":{"x":1},"ordinary":2}' }));
  assert.ok(Object.hasOwn(own, '__proto__'));
  assert.equal(Object.getPrototypeOf(own), Object.prototype);
  for (const body of ['[]', 'null', '1', '"text"']) {
    await assert.rejects(parseObjectBody(new Request('https://x.invalid', { method: 'POST', headers: { 'content-type': 'application/json' }, body })), /Invalid request body\./);
  }
  for (const body of ['', '{']) {
    await assert.rejects(parseObjectBody(new Request('https://x.invalid', { method: 'POST', headers: { 'content-type': 'application/json' }, body })), /Invalid JSON body\./);
  }
});
