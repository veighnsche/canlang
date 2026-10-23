#!/usr/bin/env node
/** Finite offline-startup and admission delta for the shipped tools. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, access, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const option = name => process.argv[process.argv.indexOf(name) + 1];
const tools = resolve(option('--tool-root')), root = resolve(option('--project-root')), state = resolve(option('--state'));
assert.ok([tools, root, state].every(path => path.startsWith('/home/')));
assert.equal(process.env.CAN_VERIFY_NETWORK_NONE, '1', 'Run this delta inside the task network-none container');
await mkdir(root, { recursive: true, mode: 0o700 });
await mkdir(state, { recursive: true, mode: 0o700 });
const repoScripts = fileURLToPath(new URL('./', import.meta.url));
const plain = join(root, 'Preview.can'), files = join(root, 'Files.can'), sodaSource = join(root, 'Soda.can');
const todoSource = join(root, 'Todo.can'), todoArtifact = join(root, 'Todo.artifact.json');
await copyFile(join(repoScripts, 'fixtures/preview-persistence.can'), plain);
await copyFile(join(repoScripts, '../packages/cloudflare/test/fixtures/native-root-files.can'), files);
await copyFile(join(repoScripts, 'fixtures/soda-runtime.can'), sodaSource);
await copyFile(join(repoScripts, '../examples/Todo.can'), todoSource);
let session;
const env = { ...process.env, CAN_TOOL_ROOT: tools, CAN_DEV_STATE_ROOT: join(state, 'retained'), TMPDIR: process.env.TMPDIR ?? join(state, 'tmp') };
await mkdir(env.TMPDIR, { recursive: true, mode: 0o700 });
const cli = join(tools, 'bin/can-dev');
function control(command, args = []) {
  let output;
  try { output = execFileSync(cli, [command, '--root', root, ...(session && command !== 'start' ? ['--session', session] : []), ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { output = error.stdout; }
  const envelope = JSON.parse(output);
  if (command === 'check' || command === 'status' || command === 'stop') console.log(JSON.stringify({ command, envelope }));
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  if (command === 'start') { assert.equal(envelope.result.attached, false); session = envelope.session; }
  return envelope.result;
}
const start = source => control('start', ['--source', source]);
try {
  start(plain);
  const checked = control('check');
  assert.equal(checked.state, 'valid', JSON.stringify(checked));
  assert.equal(control('status').preview, 'ready');
  const preview = control('preview.open');
  assert.equal((await fetch(new URL(preview.url).origin)).status, 401, 'actual protected listener');
} finally { if (session) { control('stop'); session = undefined; } }
try {
  start(files);
  const checked = control('check');
  assert.equal(checked.state, 'valid', JSON.stringify(checked));
  assert.equal(control('status').preview, 'ready', 'current Files/DO preview remains supported');
} finally { if (session) { control('stop'); session = undefined; } }
for (const directory of [root, state]) {
  try { await access(join(directory, '.wrangler')); assert.fail('offline startup created a .wrangler metadata cache'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const can = join(tools, 'bin/can');
await writeFile(todoArtifact, execFileSync(can, ['compile', '--format=json', '--native-scenario-receipts', 'Todo.can'],
  { cwd: root, env, timeout: 120000 }));
const examples = JSON.parse(execFileSync(can, ['test', '--artifact', todoArtifact],
  { cwd: root, env, encoding: 'utf8', timeout: 120000 }));
assert.equal(examples.ok, true, JSON.stringify(examples));
assert.ok(examples.executed > 0, 'Installed tools execute nonempty native examples');
const foreignCatalog = join(state, 'foreign-catalog.json');
await copyFile(join(tools, 'lib/node_modules/@canlang/cloudflare/dist/native-catalog.json'), foreignCatalog);
let foreignCatalogResult;
try {
  execFileSync(can, ['test', '--artifact', todoArtifact],
    { cwd: root, env: { ...env, CAN_CATALOG: foreignCatalog }, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) { foreignCatalogResult = JSON.parse(error.stdout); }
assert.equal(foreignCatalogResult?.code, 'native-examples-failed');
assert.match(foreignCatalogResult.detail, /catalog must belong to the selected installed producer/);
const require = createRequire(join(tools, 'lib/package.json'));
const { preflightSodaDeployment } = await import(pathToFileURL(require.resolve('@canlang/cloudflare/deploy/soda')).href);
const { CONTRACTS_VERSION } = await import(pathToFileURL(require.resolve('@canlang/contracts')).href);
const artifact = JSON.parse(execFileSync(join(tools, 'bin/can'), ['compile', '--format=json', '--native-scenario-receipts', '--catalog',
  join(tools, 'lib/node_modules/@canlang/cloudflare/dist/native-catalog.json'), sodaSource], { cwd: root, env, encoding: 'utf8' }));
const resources = [{ binding: 'DB', kind: 'd1', logicalName: 'identity' }, { binding: 'STATE_DB', kind: 'd1', logicalName: 'state' }];
const descriptor = { identity: { appName: artifact.app, sourceRevision: 'offline-test', compilerVersion: artifact.tool_version,
  languageVersion: artifact.language_version, contractsVersion: CONTRACTS_VERSION,
  artifactDigest: createHash('sha256').update(JSON.stringify(artifact)).digest('hex') }, requiredCapabilities: artifact.requires.map(item => item.capability),
  resourceBindings: resources, secrets: [], schedules: [] };
const environment = { environment: 'offline-test', resources: resources.map(requirement => ({ requirement, resourceId: requirement.logicalName })),
  secretsPresent: [], vars: { CAN_AUTH_ORIGIN: 'https://app.test' } };
preflightSodaDeployment(artifact, descriptor, environment);
assert.throws(() => preflightSodaDeployment(artifact, descriptor, { ...environment, vars: { CAN_AUTH_ORIGIN: 'http://127.0.0.1:8080' } }), /File receivers require an HTTPS/);
assert.throws(() => preflightSodaDeployment(artifact, { ...descriptor, resourceBindings: [resources[0]] }, environment), /State D1 binding STATE_DB/);
const results = { offlinePreviewStartup: true, noWranglerMetadataCache: true, devFilesAndDurableObjectsSupported: true,
  nativeExamplesExecuted: examples.executed,
  missingStateBindingRejected: true, filesHttpOriginRejected: true, tools, project: root };
await writeFile(join(state, 'startup-results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
