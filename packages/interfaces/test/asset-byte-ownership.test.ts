import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssetTable, handleAssetsRequest } from '../src/http/assets.js';
import type { AssetRow, AssetTable } from '../src/http/assets.js';

const encode = (text: string) => new TextEncoder().encode(text);
const cache = { maxAgeSeconds: 60, immutable: true };
function row(bytes: Uint8Array, key = 'a.js', mime = 'application/javascript'): AssetRow {
  return { key, bytes, mime, cache: { ...cache } };
}
function response(table: AssetTable, key = 'a.js', method = 'GET'): Response {
  return handleAssetsRequest(table, new Request(`https://local.invalid/assets/${key}`, { method }));
}
async function body(table: AssetTable, key = 'a.js'): Promise<number[]> {
  return [...new Uint8Array(await response(table, key).arrayBuffer())];
}

for (const kind of ['Uint8Array', 'subarray', 'Buffer', 'DataView', 'transfer'] as const) {
  test(`registered bytes survive retained ${kind} mutation`, async () => {
    const backing = new Uint8Array([9, 65, 66, 9]);
    const bytes = kind === 'Buffer' ? Buffer.from([65, 66])
      : kind === 'Uint8Array' ? new Uint8Array([65, 66]) : backing.subarray(1, 3);
    const table = createAssetTable([row(bytes)]);
    if (kind === 'transfer') structuredClone(backing.buffer, { transfer: [backing.buffer] });
    else if (kind === 'DataView') new DataView(backing.buffer).setUint8(1, 90);
    else bytes.fill(90);
    assert.deepEqual(await body(table), [65, 66]);
    assert.deepEqual(await body(table), [65, 66]);
  });
}

test('registered Uint8Array subclass bytes are owned even when slice returns an alias', async () => {
  class RetainedBytes extends Uint8Array {
    override slice(): this { return this; }
  }
  const input = new RetainedBytes([65, 66]), table = createAssetTable([row(input)]);
  input.fill(90);
  assert.deepEqual(await body(table), [65, 66]);
  const lookup = table.get('a.js')!;
  lookup.bytes.fill(91);
  assert.deepEqual(await body(table), [65, 66]);
});

test('registration snapshots rows, cache, input list and getter-produced bytes', async () => {
  let bytes = encode('AB'), reads = 0;
  const input = {
    key: 'a.js', get bytes() { reads += 1; return bytes; },
    mime: 'application/javascript', cache: { ...cache },
  };
  const inputs = [input], table = createAssetTable(inputs), registeredReads = reads;
  bytes.fill(90); bytes = encode('changed');
  input.key = 'renamed.css'; input.mime = 'text/css'; input.cache.maxAgeSeconds = 1;
  inputs.splice(0);
  assert.deepEqual(await body(table), [65, 66]);
  assert.equal(reads, registeredReads);
  assert.equal(response(table).headers.get('content-type'), 'application/javascript');
  assert.equal(response(table).headers.get('cache-control'), 'public, max-age=60, immutable');
  assert.equal(table.get('renamed.css'), null);
});

for (const kind of ['element', 'subarray', 'DataView', 'transfer'] as const) {
  test(`lookup ${kind} mutation cannot alter subsequent rows or served bytes`, async () => {
    const table = createAssetTable([row(encode('AB'))]), lookup = table.get('a.js')!;
    assert.equal(Object.isFrozen(lookup), true);
    assert.equal(Object.isFrozen(lookup.cache), true);
    assert.equal(Reflect.set(lookup, 'mime', 'text/css'), false);
    assert.equal(Reflect.set(lookup.cache, 'maxAgeSeconds', 1), false);
    if (kind === 'transfer') structuredClone(lookup.bytes.buffer, { transfer: [lookup.bytes.buffer] });
    else if (kind === 'DataView') new DataView(lookup.bytes.buffer).setUint8(0, 90);
    else if (kind === 'subarray') lookup.bytes.subarray(0, 1).fill(90);
    else lookup.bytes[0] = 90;
    assert.deepEqual([...table.get('a.js')!.bytes], [65, 66]);
    assert.deepEqual(await body(table), [65, 66]);
    assert.deepEqual(await body(table), [65, 66]);
  });
}

test('the constructor lookup refuses replacement while missing keys stay absent', async () => {
  const table = createAssetTable([row(encode('AB'))]);
  assert.equal(Object.isFrozen(table), true);
  assert.equal(Reflect.set(table, 'get', () => row(encode('changed'))), false);
  assert.equal(Reflect.deleteProperty(table, 'get'), false);
  assert.equal(table.get('missing'), null);
  assert.deepEqual(await body(table), [65, 66]);
});

test('GET/HEAD preserve JS/CSS and hostile exact keys across consumed body mutation', async () => {
  const rows = [row(encode('export const a=1;')), row(encode('body{color:red}'), 'app.css', 'text/css'),
    row(new Uint8Array([0, 255, 128]), '__proto__'), row(encode('constructor'), 'constructor'), row(encode('toString'), 'toString')];
  const table = createAssetTable(rows);
  for (const asset of rows) {
    const first = response(table, asset.key), firstHeaders = [...first.headers];
    const received = new Uint8Array(await first.arrayBuffer());
    assert.deepEqual([...received], [...asset.bytes]); received.fill(90);
    const repeated = response(table, asset.key), head = response(table, asset.key, 'HEAD');
    assert.deepEqual([...repeated.headers], firstHeaders);
    assert.deepEqual([...head.headers], firstHeaders);
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.deepEqual([...new Uint8Array(await repeated.arrayBuffer())], [...asset.bytes]);
    assert.equal(repeated.headers.get('content-type'), asset.mime);
    assert.equal(repeated.headers.get('content-length'), String(asset.bytes.length));
    assert.equal(repeated.headers.get('cache-control'), 'public, max-age=60, immutable');
  }
});

test('unknown paths, traversal and methods retain the same not_found response', async () => {
  const table = createAssetTable([row(encode('AB'))]), bodies = new Set<string>();
  for (const [key, method] of [['missing', 'GET'], ['', 'GET'], ['%2e%2e/secret', 'GET'], ['a//b', 'GET'], ['%ZZ', 'GET'], ['a.js', 'POST']]) {
    const result = response(table, key, method);
    assert.equal(result.status, 404);
    const text = await result.text(); bodies.add(text);
    assert.equal((JSON.parse(text) as { code: string }).code, 'not_found');
  }
  assert.equal(bodies.size, 1);
});

test('the handler still reads a dynamic injected provider on every GET/HEAD', async () => {
  let current = row(encode('A')), calls = 0;
  const provider: AssetTable = { get(key) { calls += 1; return key === 'a.js' ? current : null; } };
  assert.deepEqual(await body(provider), [65]);
  current = row(encode('BB'), 'a.js', 'text/css');
  const head = response(provider, 'a.js', 'HEAD');
  assert.equal(head.headers.get('content-length'), '2');
  assert.equal(head.headers.get('content-type'), 'text/css');
  assert.deepEqual(await body(provider), [66, 66]);
  assert.equal(calls, 3); assert.equal(Object.isFrozen(provider), false);
});
