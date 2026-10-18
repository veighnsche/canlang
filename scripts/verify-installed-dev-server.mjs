#!/usr/bin/env node
/** The installed manual workflow, against one external app and private state. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
const installation = resolve(options.get('--installation'));
const root = resolve(options.get('--project-root'));
const reportPath = resolve(options.get('--report'));
const source = join(root, 'Preview.can');
const template = await readFile(source, 'utf8');
// A real failed row exercises retained failure/rerun policy without changing app behavior.
assert.ok(template.includes('-> "Example-only mutation",8'));
const saved = template.replace('-> "Example-only mutation",8', '-> "Deliberately different expectation",8');
const can = join(installation, 'bin/can');
const env = { ...process.env, CAN_DEV_STATE_ROOT: join(root, 'retained-state') };
const requireInstalled = createRequire(join(installation, 'package.json'));
const { deriveCsrfToken } = await import(pathToFileURL(requireInstalled.resolve('@canlang/identity')));
const report = { kind: 'installed-native-manual', timings: {}, passed: [], ok: false };
const cookies = new Map();
let session, origin, csrf, grant, record;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function require(condition, message) { assert.ok(condition, message); }
async function control(command, args = [], expected = null) {
  let output, status = 0;
  const argv = command === 'help' ? ['dev', '--help']
    : ['dev', command, '--root', root, ...(session ? ['--session', session] : []), ...args];
  try { output = (await exec(can, argv,
    { cwd: root, env, timeout: 90000, maxBuffer: 128 * 1024 })).stdout; }
  catch (error) { output = error.stdout; status = error.code; }
  require(typeof output === 'string' && Buffer.byteLength(output) <= 128 * 1024 && output.trim().split('\n').length === 1, `${command}: one bounded JSON line`);
  const value = JSON.parse(output);
  if (expected) { assert.equal(value.code, expected, command); assert.equal(status, 1); return value; }
  require(value.ok === true && status === 0, `${command}: ${value.code ?? 'failed'}`);
  return value;
}
async function request(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
  if (init.method === 'POST') headers.set('origin', origin);
  const response = await fetch(new URL(path, origin), { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(';', 1)[0], equals = pair.indexOf('=');
    cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
  }
  return response;
}
function operationId() {
  const time = Date.now().toString(16).padStart(12, '0'), random = randomUUID().replaceAll('-', '');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(8, 20)}`;
}
const jsonHeaders = () => ({ 'content-type': 'application/json', 'x-csrf-token': csrf });
async function readRecords() {
  const response = await request('/mcp', { method: 'POST', headers: { ...jsonHeaders(), accept: 'application/json, text/event-stream', authorization: `Bearer ${grant}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: operationId(), method: 'tools/call', params: { name: 'PreviewPersistence.Supply.read', arguments: {} } }) });
  assert.equal(response.status, 200);
  const value = await response.json();
  require(!value.error && value.result?.isError !== true, 'authenticated MCP read');
  require(Array.isArray(value.result.structuredContent?.records), 'MCP records');
  return value.result.structuredContent.records;
}
async function access() {
  const opened = (await control('preview.open')).result;
  origin = new URL(opened.url).origin;
  assert.equal((await request(opened.url)).status, 303, 'single-use bootstrap');
  assert.equal((await request(opened.url)).status, 403, 'consumed bootstrap refuses reuse');
  return opened.actors;
}
async function check(label) {
  const started = performance.now();
  const result = (await control('check')).result;
  report.timings[label] = performance.now() - started;
  return result;
}
async function start() {
  const started = performance.now();
  const value = await control('start', ['--source', source]);
  require(value.result.attached === false, 'new owned session');
  session = value.session;
  report.timings.ownerControlMs ??= performance.now() - started;
  return started;
}
async function stop() {
  const started = performance.now();
  await control('stop'); session = undefined;
  report.timings.stopMs ??= performance.now() - started;
}
try {
  await mkdir(env.CAN_DEV_STATE_ROOT, { mode: 0o700, recursive: true });
  await writeFile(source, saved);
  const begin = await start();
  const first = await check('initialCheckMs');
  require(first.state === 'valid' && first.preview === 'ready', 'initial app ready');
  report.timings.startToReadyMs = performance.now() - begin;
  report.revision = first.revision;
  const help = (await control('help')).result;
  assert.deepEqual(help.unavailable, []);
  const actors = await access();
  require(Array.isArray(actors) && actors.length === 4, 'explicit actor credentials');
  const actor = actors.find(candidate => candidate.label === 'Ava');
  const descriptor = await request('/auth/login');
  assert.equal(descriptor.status, 200);
  const pre = await descriptor.json();
  const login = await request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: actor.email, password: actor.password, _presession: pre.preSessionToken }) });
  assert.equal(login.status, 200);
  csrf = await deriveCsrfToken(decodeURIComponent(cookies.get('can_session')));
  const teams = await (await request('/auth/teams')).json();
  const selected = await request('/auth/select-team', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ team: teams.teams[0].team_id, _csrf: csrf }) });
  assert.equal(selected.status, 200);
  const granted = await request('/mcp/grants', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ client_id: 'installed-native-manual' }) });
  assert.equal(granted.status, 200); grant = (await granted.json()).token;
  assert.deepEqual(await readRecords(), []);
  const created = await request('/api/operations/PreviewPersistence.Supply.create', { method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({ operation_id: operationId(), inputs: { name: 'Retained manual supply', quantity: '7' } }) });
  assert.equal(created.status, 200);
  const mutation = await created.json(); assert.equal(mutation.status, 'committed');
  record = mutation.records[0];
  require(record.data.name === 'Retained manual supply', 'real mutation');
  assert.deepEqual(await readRecords(), [record]);
  report.passed.push('real protected access, Identity login, team selection and D1 mutation');

  const examples = (await control('example.run', ['--expected-revision', first.revision])).result;
  require(examples.ok === false && examples.failures_retained > 0 && examples.focus, 'actual failed example retained');
  assert.deepEqual(await readRecords(), [record], 'examples cannot mutate serving data');
  const reference = examples.focus.ref;
  require((await control('failure.lookup', ['--ref', reference])).result.ref === reference, 'retained example failure lookup');
  await control('failure.detail', ['--ref', reference]);
  const rerun = (await control('example.rerun', ['--ref', reference])).result;
  require(rerun.ok === true && rerun.kind === 'isolated_example_rerun', 'exact retained single-row rerun');
  assert.deepEqual(await readRecords(), [record], 'rerun cannot mutate serving data');
  await control('construct.help', ['--revision', first.revision, '--id', 'can.v1.ui.table']);
  report.passed.push('isolated actual examples, retained failure lookup/detail and exact rerun');

  await writeFile(source, 'app PreviewPersistence\nThen\n ???\n');
  const invalid = await check('invalidCheckMs');
  const invalidStatus = (await control('status')).result;
  require(invalid.state === 'errors' && invalidStatus.serving_revision === first.revision, 'source errors retain last good preview');
  if (options.has('--compat-cli')) {
    const { stdout } = await exec(join(installation, 'libexec/node'), [resolve(options.get('--compat-cli')), 'status', '--root', root, '--session', session],
      { cwd: root, env, timeout: 10000, maxBuffer: 128 * 1024 });
    const compatible = JSON.parse(stdout);
    require(compatible.ok === true && compatible.session === session && compatible.result.serving_revision === first.revision,
      'existing JSON consumer sees the same native owner');
    report.passed.push('existing TypeScript JSON consumer controls installed native owner');
  }
  const diagnostics = (await control('diagnostics', ['--revision', invalid.revision])).result;
  require(diagnostics.diagnostics.length > 0 && Number.isInteger(diagnostics.compiler_omitted), 'bounded diagnostic page and counts');
  await control('diagnostic.detail', ['--revision', invalid.revision, '--index', '0']);
  const compilerRef = diagnostics.diagnostics[0].ref;
  await control('failure.lookup', ['--ref', compilerRef]);
  await control('failure.detail', ['--ref', compilerRef]);
  await control('construct.rank', ['--revision', invalid.revision, '--index', '0']);
  await control('rank.lookup', ['--revision', invalid.revision, '--ref', '0'.repeat(64)], 'RANK_UNAVAILABLE');
  const foreign = reference.replace(session, 'foreign-session');
  await control('failure.lookup', ['--ref', foreign], 'INVALID_FAILURE_REF');
  assert.deepEqual(await readRecords(), [record], 'last good remains authorized and serves retained data');
  report.passed.push('invalid edit, captured diagnostics, safe compiler failures, ranking refusal and last good');

  await writeFile(source, saved.replace('Persistent preview', 'Repaired persistent preview'));
  const repaired = await check('repairCheckMs');
  require(repaired.state === 'valid' && repaired.preview === 'ready' && repaired.revision !== first.revision, 'repair replaces generation');
  await access();
  assert.deepEqual(await readRecords(), [record], 'same login/grant/data after replacement');
  const historical = (await control('diagnostic.detail', ['--revision', invalid.revision, '--index', '0'])).result;
  require(historical.current === false, 'historical captured detail remains labeled');
  const stale = await request('/api/operations/PreviewPersistence.Supply.update', { method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({ operation_id: operationId(), inputs: { record: { id: record.id, version: '999' }, name: 'Must not mutate', quantity: '9' } }) });
  require(stale.status >= 400, 'actual stale version refusal');
  let failures;
  for (let i = 0; i < 30; i++) {
    failures = (await control('failures', ['--revision', repaired.revision])).result;
    if (failures.failures.some(failure => failure.origin === 'http')) break;
    await sleep(100);
  }
  const refusal = failures.failures.find(failure => failure.origin === 'http');
  require(refusal, 'serving-generation HTTP refusal retained');
  const detail = (await control('failure.detail', ['--ref', refusal.ref])).result;
  require(!JSON.stringify(detail).includes('Must not mutate'), 'safe refusal omits raw mutation inputs');
  assert.deepEqual(await readRecords(), [record]);
  report.passed.push('repair retains login/data; real HTTP refusal is safe and discoverable');
  await stop();
  await start();
  const restarted = await check('restartCheckMs');
  require(restarted.state === 'valid' && restarted.preview === 'ready', 'restart ready');
  await access();
  assert.deepEqual(await readRecords(), [record], 'same login/grant/data survive stop and restart');
  await stop();
  report.passed.push('confirmed stop and restart retain application login and data');
  report.ok = true;
} catch (error) { report.error = error.message; }
finally {
  if (session) { try { await stop(); report.cleanup = true; } catch (error) { report.cleanupError = error.message; } }
  report.compilerSha256 = createHash('sha256').update(await readFile(join(installation, 'libexec/can'))).digest('hex');
  report.devServerSha256 = createHash('sha256').update(await readFile(join(installation, 'libexec/can-dev'))).digest('hex');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
if (!report.ok) process.exitCode = 1;
