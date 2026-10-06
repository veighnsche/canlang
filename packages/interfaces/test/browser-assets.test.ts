/**
 * FP.BROWSER-ASSETS.1 pins: exact-key byte serving from an injected
 * immutable table — GET/HEAD only, byte-exact JS/CSS, explicit cache
 * policy, authored not_found for unknown methods/paths/traversal,
 * wiring-time table validation, and caller/session independence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSETS_PREFIX,
  createAssetTable,
  handleAssetsRequest,
} from '../src/http/assets.js';
import type { AssetTable } from '../src/http/assets.js';

const JS = 'console.log("bootstrap");\n';
const CSS = 'body{color:red}\n';

function table(): AssetTable {
  return createAssetTable([
    {
      key: 'browser/bootstrap.js',
      bytes: new TextEncoder().encode(JS),
      mime: 'application/javascript',
      cache: { maxAgeSeconds: 31_536_000, immutable: true },
    },
    {
      key: 'browser/poll.js',
      bytes: new TextEncoder().encode('poll();\n'),
      mime: 'application/javascript',
      cache: { maxAgeSeconds: 60, immutable: false },
    },
    {
      key: 'app.css',
      bytes: new TextEncoder().encode(CSS),
      mime: 'text/css',
      cache: { maxAgeSeconds: 3600, immutable: false },
    },
  ]);
}

function get(path: string, method = 'GET'): Request {
  return new Request(`https://host.test${path}`, { method });
}

test('assets: GET serves byte-exact bodies with exact MIME + cache policy', async () => {
  const t = table();
  const js = await handleAssetsRequest(t, get(`${ASSETS_PREFIX}browser/bootstrap.js`));
  assert.equal(js.status, 200);
  assert.equal(js.headers.get('content-type'), 'application/javascript');
  assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await js.text(), JS);
  const css = await handleAssetsRequest(t, get(`${ASSETS_PREFIX}app.css`));
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css');
  assert.equal(css.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(await css.text(), CSS);
});

test('assets: HEAD returns GET headers with no body', async () => {
  const t = table();
  const head = await handleAssetsRequest(t, get(`${ASSETS_PREFIX}browser/bootstrap.js`, 'HEAD'));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'application/javascript');
  assert.equal(head.headers.get('content-length'), String(new TextEncoder().encode(JS).length));
  assert.equal(await head.text(), '');
});

test('assets: unknown methods/paths answer authored not_found (no oracle)', async () => {
  const t = table();
  const bodies = new Set<string>();
  const cases: Array<[string, string]> = [
    ['POST', `${ASSETS_PREFIX}browser/bootstrap.js`],
    ['PUT', `${ASSETS_PREFIX}browser/bootstrap.js`],
    ['GET', `${ASSETS_PREFIX}missing.js`],
    ['GET', '/assets/'],
    ['GET', '/other'],
    ['GET', `${ASSETS_PREFIX}BROWSER/bootstrap.js`],
  ];
  for (const [method, path] of cases) {
    const res = await handleAssetsRequest(t, get(path, method));
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.equal((JSON.parse(text) as { code: string }).code, 'not_found');
    bodies.add(text);
  }
  assert.equal(bodies.size, 1);
});

test('assets: encoded traversal never escapes the exact-key registry', async () => {
  const t = table();
  for (const path of [
    `${ASSETS_PREFIX}../secret`,
    `${ASSETS_PREFIX}%2e%2e/secret`,
    `${ASSETS_PREFIX}browser/%2e%2e/secret`,
    `${ASSETS_PREFIX}browser//bootstrap.js`,
    `${ASSETS_PREFIX}.`,
    `${ASSETS_PREFIX}%2e`,
  ]) {
    const res = await handleAssetsRequest(t, get(path));
    assert.equal(res.status, 404);
  }
});

test('assets: table validation fails wiring-time (host-fatal)', () => {
  const row = {
    key: 'a.js',
    bytes: new Uint8Array([1]),
    mime: 'application/javascript',
    cache: { maxAgeSeconds: 1, immutable: false },
  };
  assert.throws(() => createAssetTable([{ ...row, key: '' }]), /non-empty/);
  assert.throws(() => createAssetTable([{ ...row, key: '../x' }]), /traversal/);
  assert.throws(() => createAssetTable([{ ...row, key: 'a//b' }]), /traversal/);
  assert.throws(() => createAssetTable([row, row]), /duplicate/);
  assert.throws(() => createAssetTable([{ ...row, mime: 'text/html' }]), /MIME/);
  assert.throws(
    () => createAssetTable([{ ...row, cache: { maxAgeSeconds: -1, immutable: false } }]),
    /max age/,
  );
});

test('assets: served bodies are caller-proof copies; no session read', async () => {
  const bytes = new TextEncoder().encode(JS);
  const t = createAssetTable([
    { key: 'a.js', bytes, mime: 'application/javascript', cache: { maxAgeSeconds: 1, immutable: false } },
  ]);
  bytes[0] = 88;
  const res = await handleAssetsRequest(t, get(`${ASSETS_PREFIX}a.js`));
  assert.equal(await res.text(), JS);
  // Same bytes with and without session/auth-shaped headers: content
  // never depends on the caller.
  const authed = new Request(`https://host.test${ASSETS_PREFIX}a.js`, {
    headers: { cookie: 'session=forged', authorization: 'Bearer forged' },
  });
  const res2 = await handleAssetsRequest(t, authed);
  assert.equal(await res2.text(), JS);
});
