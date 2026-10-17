#!/usr/bin/env node
/** Reopen the retained native witness after its stopped-storage backup/restore. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSodaTestGateway, openSodaHttpClient, sodaToolPaths } from './verify-soda-runtime.mjs';
const option = name => process.argv[process.argv.indexOf(name) + 1];
const tools = resolve(option('--tool-root')), state = resolve(option('--state'));
assert.ok(state.startsWith('/home/'));
process.env.TMPDIR = join(state, 'tmp');
const { require } = sodaToolPaths(tools);
const { startSodaRuntime } = await import(pathToFileURL(require.resolve('@canlang/cloudflare/deploy/soda-run')).href);
const input = JSON.parse(await readFile(join(state, 'input.json'), 'utf8'));
input.bundle.binaries = Object.fromEntries(Object.entries(input.bundle.binaries).map(([key, bytes]) => [key, Buffer.from(bytes, 'base64')]));
const seed = JSON.parse(await readFile(join(state, 'actors.json'), 'utf8'));
const configuration = JSON.parse(await readFile(join(state, 'test-gateway.json'), 'utf8'));
const gateway = await createSodaTestGateway(tools, state, configuration);
const began = performance.now();
let runtime;
let result;
try {
  runtime = await startSodaRuntime(input, { dataDir: join(state, 'restored-data'), ownerTeam: seed.probe.teamId,
    host: '127.0.0.1', port: gateway.backendPort });
  const client = await openSodaHttpClient({ toolRoot: tools, origin: runtime.origin, actors: seed.actors }, 'Ava');
  const entries = await client.entries();
  assert.equal(entries.length, 1, 'restored state must retain the actual singleton source record');
  assert.equal(entries[0].data.ticks, '1', 'restored occurrence receipt and scheduled mutation');
  const file = await client.request(`/files/read/SodaRuntime.Entry/${entries[0].id}/attachment`);
  assert.equal(file.status, 200, await file.clone().text());
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from('%PDF-1.4\ntrailer\n'));
  await runtime.wake();
  assert.equal((await client.entries())[0].data.ticks, '1', 'restored occurrence receipt survives actual scheduler wake');
  result = { verifiedBy: 'scripts/verify-soda-recovery.mjs actual application calls', dataDir: join(state, 'restored-data'),
    ordinaryAvaLogin: true, mcpSingletonEntry: true, ticks: '1', authorizedExactFileBytes: true,
    replayDidNotDuplicate: true, installedTools: tools };
} finally {
  try { if (runtime) await runtime.dispose(); }
  finally { await gateway.close(); }
}
result.gracefulShutdown = true;
result.applicationReopenReadAndShutdownWallSeconds = (performance.now() - began) / 1000;
const receipt = JSON.parse(await readFile(join(state, 'recovery-results.json'), 'utf8'));
receipt.qualification = 'stopped filesystem copy/checksum plus actual application reopen/read scope';
receipt.applicationRecovery = result;
receipt.applicationRecoveryCommand = `node scripts/verify-soda-recovery.mjs --tool-root ${JSON.stringify(tools)} --state ${JSON.stringify(state)}`;
await writeFile(join(state, 'recovery-results.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
