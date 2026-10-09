import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { installed, roots, manifests, descriptors } from './write-manifests.mjs';

const require = createRequire(join(installed, 'package.json'));
const { deriveCsrfToken } = await import(pathToFileURL(require.resolve('@canlang/identity')).href);
const run = promisify(execFile);
const cli = join(installed, 'packages/cloudflare/dist/dev/control-cli.js');
const output = join(installed, 'test-results/can-dev-server/lifecycle-auth-result.json');
const source = join(roots.a, 'tests/integration/can-dev-server/OfficeSupplies.can');
const original = await readFile(source, 'utf8');
const sessions = new Map();
const facts = { schema: 'can-dev-lifecycle-local.v1', outcome: 'incomplete' };

async function envelope(which, command, flags = [], selected = sessions.get(which)) {
  const args = ['dev', command, ...(command === 'start' ? ['--capture', manifests[which]] : ['--root', roots[which]]),
    ...(selected ? ['--session', selected, '--app', 'OfficeSupplies', '--profile', 'local-d1-identity'] : []), ...flags];
  let stdout;
  try { ({ stdout } = await run(join(roots[which], 'compiler/target/debug/can'), args, {
    cwd: roots[which], env: { ...process.env, CAN_DEV_BIN: cli }, timeout: 110_000, maxBuffer: 1024 * 1024 })); }
  catch (error) { if (!error.stdout?.trim()) throw error; stdout = error.stdout; }
  assert.equal(stdout.trimEnd().split('\n').length, 1, 'single JSON control envelope');
  return JSON.parse(stdout);
}
async function control(which, command, flags = []) {
  const response = await envelope(which, command, flags);
  assert.equal(response.ok, true, `${which} ${command}: ${response.code ?? 'failed'}`);
  assert.equal(response.session, sessions.get(which), `${which}: exact session`);
  return response.result;
}
async function owner(which) {
  const descriptor = JSON.parse(await readFile(descriptors[which], 'utf8'));
  assert.equal(descriptor.root, roots[which]);
  assert.equal(descriptor.sessionId, sessions.get(which));
  assert.equal(descriptor.app, 'OfficeSupplies');
  assert.equal(descriptor.profile, 'local-d1-identity');
}
function cookie(response, name) {
  const item = response.headers.getSetCookie().find(value => value.startsWith(`${name}=`));
  assert.ok(item, `cookie ${name} unavailable`);
  return item.split(';', 1)[0];
}
function operationId() {
  const time = Date.now().toString(16).padStart(12, '0');
  const bytes = randomBytes(10).toString('hex');
  const variant = ((parseInt(bytes[3], 16) & 3) | 8).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${bytes.slice(0, 3)}-${variant}${bytes.slice(4, 7)}-${bytes.slice(7, 19)}`;
}
async function page(selected) {
  const response = await fetch(`${selected.origin}/`, { headers: selected.headers });
  assert.equal(response.status, 200, `${selected.which}: page`);
  return response.text();
}
async function openAndLogin(which) {
  const opened = await control(which, 'preview.open');
  const origin = new URL(opened.url).origin;
  const actor = opened.actors.find(item => item.label === 'Ava');
  assert.ok(actor, `${which}: real member`);
  const bootstrap = await fetch(opened.url, { redirect: 'manual' });
  assert.equal(bootstrap.status, 303);
  const bridgeCookie = cookie(bootstrap, 'can_dev_preview');
  const descriptorResponse = await fetch(`${origin}/auth/login`, { headers: { cookie: bridgeCookie } });
  assert.equal(descriptorResponse.status, 200);
  const descriptor = await descriptorResponse.json();
  const login = await fetch(`${origin}/auth/login`, { method: 'POST',
    headers: { cookie: bridgeCookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: actor.email, password: actor.password, _presession: descriptor.preSessionToken }) });
  assert.equal(login.status, 200);
  const appCookie = cookie(login, 'can_session');
  const csrf = await deriveCsrfToken(decodeURIComponent(appCookie.slice('can_session='.length)));
  const headers = { cookie: `${bridgeCookie}; ${appCookie}` };
  const teamsResponse = await fetch(`${origin}/auth/teams`, { headers });
  assert.equal(teamsResponse.status, 200);
  const teams = await teamsResponse.json();
  assert.equal(teams.teams.length, 1);
  const team = teams.teams[0].team_id;
  const select = await fetch(`${origin}/auth/select-team`, { method: 'POST',
    headers: { ...headers, origin, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ team, _csrf: csrf }) });
  assert.equal(select.status, 200);
  const selected = { which, origin, headers, csrf, servingBuild: opened.serving_build };
  return { ...selected, pageStatus: 200, page: await page(selected), teamsCount: teams.teams.length };
}
async function create(selected, marker) {
  const response = await fetch(`${selected.origin}/api/operations/OfficeSupplies.Supply.create`, {
    method: 'POST', headers: { ...selected.headers, origin: selected.origin,
      'content-type': 'application/json', 'x-csrf-token': selected.csrf },
    body: JSON.stringify({ operation_id: operationId(), inputs: { name: marker, quantity: '3' } }) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'committed');
  assert.ok(body.records?.some(row => row.data?.name === marker && row.data.quantity === '3'));
  return { createStatus: response.status, createCode: body.code ?? null,
    createMessage: typeof body.message === 'string' ? body.message.replaceAll(marker, '[redacted]') : null,
    createFields: Array.isArray(body.fields) ? body.fields.map(item => ({ path: item.path, code: item.code })) : [] };
}
async function inspect(selected, marker) {
  const granted = await fetch(`${selected.origin}/mcp/grants`, { method: 'POST',
    headers: { ...selected.headers, origin: selected.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'lifecycle-probe' }) });
  const grant = await granted.json();
  assert.equal(granted.status, 200);
  assert.equal(typeof grant.token, 'string');
  const send = async (id, method, params) => {
    const response = await fetch(`${selected.origin}/mcp`, { method: 'POST',
      headers: { ...selected.headers, origin: selected.origin, authorization: `Bearer ${grant.token}`,
        'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    return { status: response.status, body: await response.json() };
  };
  const listed = await send(2, 'tools/list', {});
  const read = await send(3, 'tools/call', { name: 'OfficeSupplies.Supply.read', arguments: {} });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.result?.tools?.some(item => item.name === 'OfficeSupplies.Supply.read'));
  assert.equal(read.status, 200);
  assert.notEqual(read.body.result?.isError, true);
  const records = read.body.result?.structuredContent?.records;
  assert.ok(Array.isArray(records));
  return { grantStatus: granted.status, listStatus: listed.status, tools: listed.body.result.tools.map(item => item.name),
    readStatus: read.status, readIsError: read.body.result?.isError ?? null,
    readHasMarker: records.some(row => row.data?.name === marker), readChars: JSON.stringify(read.body).length,
    readCode: read.body.error?.code ?? null, count: records.length };
}
async function stop(which) {
  await owner(which);
  assert.equal((await control(which, 'stop')).stopped, true);
  const removed = await stat(descriptors[which]).then(() => false, error => {
    if (error.code === 'ENOENT') return true;
    throw error;
  });
  assert.equal(removed, true);
  sessions.delete(which);
  return { stopped: true, descriptorRemoved: true };
}

try {
  for (const which of ['a', 'b']) {
    const started = await envelope(which, 'start', [], null);
    assert.equal(started.ok, true, `${which} start: ${started.code ?? 'failed'}`);
    assert.equal(started.result.attached, false);
    sessions.set(which, started.session);
    assert.equal(started.result.root, roots[which]);
    await owner(which);
    assert.equal((await control(which, 'discover')).root, roots[which]);
    const checked = await control(which, 'check');
    assert.equal(checked.state, 'valid'); assert.equal(checked.preview, 'ready'); assert.equal(checked.current, true);
  }
  assert.notEqual(sessions.get('a'), sessions.get('b'));
  const duplicate = await envelope('a', 'start', [], null);
  assert.equal(duplicate.ok, true); assert.equal(duplicate.result.attached, true);
  assert.equal(duplicate.session, sessions.get('a'));
  const foreign = await envelope('b', 'status', [], sessions.get('a'));
  assert.equal(foreign.ok, false); assert.equal(foreign.code, 'SESSION_MISMATCH');
  facts.owners = { distinctSessions: true, duplicateAttachesOwnSession: true, crossRootRefused: true };
  const a = await openAndLogin('a'); const b = await openAndLogin('b');
  assert.notEqual(a.origin, b.origin); assert.notEqual(a.servingBuild, b.servingBuild);
  facts.distinctOrigins = true; facts.distinctServingBuilds = true;
  const marker = 'Cross-worktree probe';
  assert.equal(a.page.includes(marker), false); assert.equal(b.page.includes(marker), false);
  const created = await create(a, marker);
  assert.equal((await page(a)).includes(marker), true); assert.equal((await page(b)).includes(marker), false);
  facts.a = { pageStatus: a.pageStatus, teamsCount: a.teamsCount, initialHasMarker: false, ...created,
    finalPageStatus: 200, finalHasMarker: true, pageError: null };
  facts.b = { pageStatus: b.pageStatus, teamsCount: b.teamsCount, initialHasMarker: false, finalPageStatus: 200, finalHasMarker: false };
  facts.mcp = { a: await inspect(a, marker), b: await inspect(b, marker) };
  assert.equal(facts.mcp.a.readHasMarker, true); assert.equal(facts.mcp.b.readHasMarker, false);
  const bMarker = 'Independent B item'; await create(b, bMarker);
  const beforeA = await control('a', 'status'); const beforeB = await control('b', 'status');
  facts.revisions = { a: beforeA.revision, b: beforeB.revision,
    aSource: beforeA.source_revision, bSource: beforeB.source_revision };
  assert.equal(original.split('\nWhen\n').length, 2);
  await writeFile(source, original.replace('\nWhen\n', '\nWhen\n unknown_operation\n'));
  const invalid = await control('a', 'check');
  assert.equal(invalid.state, 'errors'); assert.equal(invalid.current, true); assert.ok(invalid.focus);
  const stale = await control('a', 'status');
  assert.equal(stale.stale, true); assert.equal(stale.serving_revision, beforeA.serving_revision);
  assert.equal(stale.serving_build, beforeA.serving_build); assert.equal((await page(a)).includes(marker), true);
  const diagnostic = await control('a', 'diagnostic.detail', ['--revision', invalid.revision, '--index', '0']);
  assert.equal(diagnostic.revision, invalid.revision); assert.equal(diagnostic.ref, invalid.focus.ref);
  assert.equal((await control('a', 'failure.lookup', ['--ref', invalid.focus.ref])).ref, invalid.focus.ref);
  assert.equal((await control('b', 'status')).serving_build, beforeB.serving_build);
  assert.equal((await page(b)).includes(bMarker), true);
  facts.invalidEdit = { state: invalid.state, stale: true, oldServingBuildRetained: true,
    diagnosticCode: diagnostic.diagnostic.code, retainedFailure: true, bUnaffected: true };
  await writeFile(source, original + '\n## Lifecycle repair forces a fresh build.\n');
  const repaired = await control('a', 'check');
  assert.equal(repaired.state, 'valid'); assert.equal(repaired.preview, 'ready');
  const reset = await control('a', 'status');
  assert.equal(reset.stale, false); assert.equal(reset.preview_reset, true);
  assert.notEqual(reset.serving_build, beforeA.serving_build);
  const retained = await control('a', 'diagnostic.detail', ['--revision', invalid.revision, '--index', '0']);
  assert.equal(retained.current, false); assert.deepEqual(retained.diagnostic, diagnostic.diagnostic);
  const freshA = await openAndLogin('a');
  assert.equal((await page(freshA)).includes(marker), false); assert.equal((await inspect(freshA, marker)).count, 0);
  assert.equal((await inspect(b, bMarker)).readHasMarker, true);
  facts.repair = { valid: true, rebuilt: true, resetData: true, retainedDiagnostic: true, bDataRetained: true };
  facts.stopB = await stop('b');
  const afterStopMarker = 'A remains functional'; await create(freshA, afterStopMarker);
  assert.equal((await page(freshA)).includes(afterStopMarker), true);
  assert.equal((await inspect(freshA, afterStopMarker)).readHasMarker, true);
  facts.aFunctionalAfterStopB = true; facts.stopA = await stop('a'); facts.outcome = 'passed';
} catch (error) {
  facts.outcome = 'failed'; process.exitCode = 1;
  facts.failure = { name: error.name, message: String(error.message).split('\n', 1)[0].slice(0, 300) };
} finally {
  try {
    await writeFile(source, original); facts.sourceRestored = (await readFile(source, 'utf8')) === original;
    assert.equal(facts.sourceRestored, true);
  } catch (error) {
    facts.outcome = 'failed'; process.exitCode = 1;
    facts.sourceRestoreError = String(error.message).split('\n', 1)[0].slice(0, 200);
  }
  for (const which of ['b', 'a']) {
    if (!sessions.has(which)) continue;
    try { facts[`cleanup${which.toUpperCase()}`] = await stop(which); }
    catch (error) { facts.outcome = 'failed'; process.exitCode = 1;
      facts[`cleanup${which.toUpperCase()}`] = { error: String(error.message).split('\n', 1)[0].slice(0, 200) }; }
  }
  await writeFile(output, JSON.stringify(facts, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(facts, null, 2));
}
