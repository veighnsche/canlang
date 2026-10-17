#!/usr/bin/env node
/** Real can-dev HTTP persistence and example isolation with task-owned state. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(fileURLToPath(new URL('../', import.meta.url)));
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const tools = resolve(option('--tool-root') ?? repo);
const root = resolve(option('--project-root') ?? repo);
const requestedState = option('--state') ?? join(repo, '.artifacts/preview-persistence');
assert.ok(isAbsolute(requestedState), '--state must be an absolute task-owned path');
const state = resolve(requestedState);
const contains = (parent, child) => {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path);
};
const permittedRoots = [repo, homedir()].map(path => realpathSync(path));
assert.ok(permittedRoots.some(parent => contains(parent, state)), '--state must be a descendant of the checkout or current HOME');
let existingParent = state;
while (!existsSync(existingParent)) existingParent = dirname(existingParent);
const canonicalState = resolve(realpathSync(existingParent), relative(existingParent, state));
assert.ok(permittedRoots.some(parent => contains(parent, canonicalState)), '--state must not escape through a directory symlink');
if (typeof process.getuid === 'function') assert.equal(statSync(existingParent).uid, process.getuid(), '--state parent must belong to the current user');
await mkdir(state, { recursive: true, mode: 0o700 });
const temporary = join(process.env.TMPDIR ?? join(homedir(), '.cache'), `can-preview-${createHash('sha256').update(state).digest('hex').slice(0, 8)}`);
await mkdir(temporary, { recursive: true, mode: 0o700 });
const fixtureDirectory = join(root, '.artifacts', 'preview-persistence-input');
await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 });
const fixture = join(fixtureDirectory, 'Preview.can');
await copyFile(join(repo, 'scripts/fixtures/preview-persistence.can'), fixture);
const env = { ...process.env, TMPDIR: temporary, CAN_DEV_STATE_ROOT: join(state, 'retained'),
  ...(tools === root ? {} : { CAN_TOOL_ROOT: tools }) };
const installed = existsSync(join(tools, 'tools.json'));
const compiler = resolve(option('--compiler') ?? join(tools, installed ? 'compiler/target/release/can' : 'compiler/target/debug/can'));
const catalog = join(tools, installed ? 'lib/node_modules/@canlang/cloudflare/dist/native-catalog.json' : 'packages/values/dist/catalog.json');
const help = join(tools, 'docs/specification/CONSTRUCT-HELP.md');
const cli = join(tools, installed ? 'bin/can-dev' : 'packages/cloudflare/dist/dev/control-cli.js');
let session;
function control(command, args = []) {
  let output;
  try { output = execFileSync(installed ? cli : process.execPath, [...(installed ? [] : [cli]), command, '--root', root,
    ...(session && command !== 'start' ? ['--session', session] : []), ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { output = error.stdout; }
  const envelope = JSON.parse(output);
  assert.equal(envelope.ok, true, `${command}: ${envelope.code ?? ''} ${envelope.detail ?? ''}`);
  if (command === 'start') { assert.equal(envelope.result.attached, false, 'proof needs an unowned Project'); session = envelope.session; }
  return envelope.result;
}
const owningRequire = createRequire(join(tools, installed ? 'lib/package.json' : 'package.json'));
const { deriveCsrfToken } = await import(pathToFileURL(owningRequire.resolve('@canlang/identity')).href);
async function open() {
  control('start', ['--source', fixture, '--app', 'PreviewPersistence', '--compiler', compiler, '--catalog', catalog, '--help-index', help]);
  const deadline = Date.now() + 60_000;
  let checked;
  do {
    checked = control('check');
    if (checked.state !== 'superseded') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  assert.equal(checked.state, 'valid', JSON.stringify(checked));
  const status = control('status');
  assert.equal(status.preview, 'ready', JSON.stringify(status));
  const opened = control('preview.open');
  const origin = new URL(opened.url).origin;
  const cookies = new Map();
  const request = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    if (init.method === 'POST') headers.set('origin', origin);
    const response = await fetch(new URL(path, origin), { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0], index = pair.indexOf('=');
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  };
  assert.equal((await fetch(origin)).status, 401);
  assert.equal((await request(opened.url)).status, 303);
  const actor = opened.actors.find(actor => actor.label === 'Ava');
  const pre = await (await request('/auth/login')).json();
  assert.equal((await request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: actor.email, password: actor.password, _presession: pre.preSessionToken }) })).status, 200);
  const csrf = await deriveCsrfToken(decodeURIComponent(cookies.get('can_session')));
  const teams = await (await request('/auth/teams')).json();
  assert.equal((await request('/auth/select-team', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ team: teams.teams[0].team_id, _csrf: csrf }) })).status, 200);
  return { request, csrf, actor, revision: status.revision };
}
function operationId() {
  const time = Date.now().toString(16).padStart(12, '0'), bytes = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${bytes.slice(0, 3)}-${((parseInt(bytes[3], 16) & 3) | 8).toString(16)}${bytes.slice(4, 7)}-${bytes.slice(7, 19)}`;
}
const name = `Persisted ${randomBytes(8).toString('hex')}`;
let firstActor;
try {
  const preview = await open(); firstActor = preview.actor;
  const written = await preview.request('/api/operations/PreviewPersistence.Supply.create', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': preview.csrf },
    body: JSON.stringify({ operation_id: operationId(), inputs: { name, quantity: "7" } }) });
  assert.equal(written.status, 200); assert.equal((await written.json()).status, 'committed');
  const before = await (await preview.request('/')).text();
  assert.match(before, new RegExp(name)); assert.doesNotMatch(before, /Example fixture|Example-only mutation/);
  const examples = control('example.run', ['--expected-revision', preview.revision]);
  await writeFile(join(state, 'example-result.json'), JSON.stringify(examples, null, 2));
  assert.equal(examples.ok, true, JSON.stringify(examples));
  assert.equal(examples.executed, 2, JSON.stringify(examples));
  assert.equal(examples.summary.failed, 0);
  assert.equal(examples.summary.setupFailed, 0);
  assert.equal(examples.summary.unsupported, 0);
  const after = await (await preview.request('/')).text();
  assert.match(after, new RegExp(name)); assert.doesNotMatch(after, /Example fixture|Example-only mutation/);
} finally { if (session) { control('stop'); session = undefined; } }
try {
  const restarted = await open();
  assert.deepEqual(restarted.actor, firstActor, 'ordinary seeded Identity credentials must survive restart');
  const page = await restarted.request('/'); assert.equal(page.status, 200); assert.match(await page.text(), new RegExp(name));
} finally { if (session) { control('stop'); session = undefined; } }
const results = { previewHttpWrite: true, previewRestart: true, identityRetained: true, protectedPreview: true, isolatedExamples: true,
  node: process.version, tools, projectRoot: root };
await writeFile(join(state, 'results.json'), JSON.stringify(results, null, 2));
await rm(temporary, { recursive: true, force: true });
console.log(JSON.stringify(results, null, 2));
