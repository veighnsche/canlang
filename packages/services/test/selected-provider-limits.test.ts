import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SystemOneAdapter, JudgmentValidationError } from '../src/judgments/systemone.js';
import { ComfyUINativeAdapter } from '../src/media/comfyui.js';
import { MappingValidationError } from '../src/media/mapping.js';
import { fixedClock } from '../src/ports.js';

function judgment(cap: number | null) {
  return new SystemOneAdapter({ baseUrl: 'https://provider.invalid', timeoutMs: 1000,
    maxBodyBytes: 10000, models: ['m'], minChoiceOptions: 1, maxChoiceOptions: 10,
    minScoreLevels: 2, maxScoreLevels: 10, maxRequestBytes: cap, clock: fixedClock(1) });
}
function media() {
  return new ComfyUINativeAdapter({ baseUrl: 'https://provider.invalid', timeoutMs: 1000,
    maxBodyBytes: 10000, maxDownloadBytes: 10000, maxOutputs: 1, clientId: 'binding', graph: {},
    mapping: { workflow: 'fixture', graphDigest: 'unused-by-cancel', inputs: {}, outputs: [] } });
}
const body = (instructions: string) =>
  `{"model":"m","state":{},"questions":{"q":{"type":"noul","instructions":${JSON.stringify(instructions)}}}}`;

for (const [name, instructions, cap, bytes] of [
  ['ASCII at cap', 'e', 77, 77], ['UTF8 at cap', 'é', 78, 78],
  ['disabled cap', 'é', null, 78],
] as const) {
  test(`judgment ${name} sends exact original bytes`, async (t) => {
    const requests: Request[] = []; const recorded: Uint8Array[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      const request = new Request(url, init); requests.push(request);
      recorded.push(new Uint8Array(await request.arrayBuffer()));
      return Response.json({ model: 'm', answers: { q: { type: 'noul', noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const completion = await judgment(cap).evaluate({ model: 'm', state: {},
      questions: [{ kind: 'noul', id: 'q', instructions }] }, { deliveryId: 'delivery' });
    assert.equal(completion.status, 'succeeded'); assert.equal(requests.length, 1);
    assert.equal(requests[0]!.method, 'POST'); assert.equal(new URL(requests[0]!.url).pathname, '/v1/systemone');
    assert.equal(recorded[0]!.byteLength, bytes);
    assert.deepEqual(recorded[0], new TextEncoder().encode(body(instructions)));
  });
}

test('judgment UTF8 78 under cap 77 refuses before provider demand', async (t) => {
  let demands = 0;
  t.mock.method(globalThis, 'fetch', async () => { demands += 1; return Response.json({}); });
  await assert.rejects(judgment(77).evaluate({ model: 'm', state: {},
    questions: [{ kind: 'noul', id: 'q', instructions: 'é' }] }, { deliveryId: 'delivery' }),
  (error: unknown) => error instanceof JudgmentValidationError &&
    error.message === 'Judgment request is 78 bytes; binding allows 77');
  assert.equal(demands, 0);
});

for (const [status, note] of [[200, 'Cancellation requested;'],
  [404, 'Targeted cancel unsupported'], [500, 'Cancel outcome uncertain;']] as const) {
  test(`media valid identity preserves best-effort cancel ${status} then observation`, async (t) => {
    const requests: { method: string; path: string }[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      const request = new Request(url, init); requests.push({ method: request.method, path: new URL(request.url).pathname });
      return request.method === 'POST' ? Response.json({}, { status }) : Response.json({});
    });
    const completion = await media().cancel('job /1', { deliveryId: 'delivery' });
    assert.deepEqual(requests, [{ method: 'POST', path: '/api/jobs/job%20%2F1/cancel' },
      { method: 'GET', path: '/history/job%20%2F1' }]);
    assert.equal(completion.delivery_id, 'delivery'); assert.equal(completion.status, 'succeeded');
    assert.equal(completion.result!.state, 'unknown'); assert.ok(completion.result!.detail!.startsWith(note));
  });
}

test('media empty delivery identity refuses before cancellation POST', async (t) => {
  let demands = 0;
  t.mock.method(globalThis, 'fetch', async () => { demands += 1; return Response.json({}); });
  await assert.rejects(media().cancel('job', { deliveryId: '' }),
    (error: unknown) => error instanceof MappingValidationError && error.message === 'deliveryId must be a non-empty string');
  assert.equal(demands, 0);
});

test('media invalid job remains the first refusal before delivery getter or provider demand', async (t) => {
  let demands = 0; let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => { demands += 1; return Response.json({}); });
  await assert.rejects(media().cancel('', { get deliveryId(): string { reads += 1; throw new Error('unexpected getter'); } }),
    (error: unknown) => error instanceof MappingValidationError && error.message === 'job must be a non-empty string');
  assert.equal(reads, 0); assert.equal(demands, 0);
});
