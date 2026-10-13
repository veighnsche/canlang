import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetContentType, createAssetTable, handleAssetsRequest } from '../src/http/assets.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const parent = dirname(testDir);
const packageRoot = basename(parent) === 'dist' ? dirname(parent) : parent;
const png = new Uint8Array(readFileSync(resolve(packageRoot, '../../editors/vscode/images/previews/light-dark-16.png')));

test('MCP asset.bin uses a recognized existing asset signature and serves exact bytes', async () => {
  const mime = assetContentType('asset.bin', png);
  assert.equal(mime, 'image/png');
  const table = createAssetTable([{key:'can.generated/u1/asset.bin',bytes:png,mime,cache:{maxAgeSeconds:0,immutable:false}}]);
  const response = handleAssetsRequest(table,new Request('https://can.test/assets/can.generated/u1/asset.bin?version=1'));
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'image/png');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),png);
  assert.equal(handleAssetsRequest(table,new Request('https://can.test/assets/can.generated/u1/missing.bin')).status,404);
});

test('unknown binaries, HTML fallback and mismatched declared asset types refuse', () => {
  const html = new TextEncoder().encode('<html><script>unexpected()</script></html>');
  assert.throws(()=>assetContentType('asset.bin',html),/unsupported or mismatched/);
  assert.throws(()=>assetContentType('asset.svg',html),/unsupported or mismatched/);
  assert.throws(()=>assetContentType('asset.jpg',png),/unsupported or mismatched/);
  assert.throws(()=>assetContentType('asset.bin',new Uint8Array([1,2,3])),/unsupported or mismatched/);
  assert.throws(()=>createAssetTable([{key:'asset.html',bytes:html,mime:'text/html',cache:{maxAgeSeconds:0,immutable:false}}]),/non-admitted MIME/);
});
