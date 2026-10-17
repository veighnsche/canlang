#!/usr/bin/env node
/** Finite native Soda application witness. The owning launcher supplies retained host lifecycle. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { request as requestHttp } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const operationId = () => {
  const time = Date.now().toString(16).padStart(12, '0'), bytes = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${bytes.slice(0, 3)}-${((parseInt(bytes[3], 16) & 3) | 8).toString(16)}${bytes.slice(4, 7)}-${bytes.slice(7, 19)}`;
};
const pdf = Buffer.from('%PDF-1.4\ntrailer\n');

/** Resolve the current standalone install or the retained offline tools layout. */
export function sodaToolPaths(toolRoot) {
  const moduleRoot = existsSync(join(toolRoot, 'node_modules/@canlang/cloudflare/package.json'))
    ? toolRoot : join(toolRoot, 'lib');
  const require = createRequire(join(moduleRoot, 'package.json'));
  return { require, cloudflare: join(moduleRoot, 'node_modules/@canlang/cloudflare'),
    node: existsSync(join(toolRoot, 'libexec/node')) ? join(toolRoot, 'libexec/node') : join(toolRoot, 'bin/node'),
    compiler: join(toolRoot, 'bin/can') };
}


/** Task-owned TLS boundary for the native HTTP listener; canonical File grants stay HTTPS. */
export async function createSodaTestGateway(toolRoot, state, options = {}) {
  await mkdir(state, { recursive: true, mode: 0o700 });
  const certificate = join(state, 'test-gateway-cert.pem'), key = join(state, 'test-gateway-key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', certificate], { stdio: 'ignore' });
  const cert = await readFile(certificate);
  const { require } = sodaToolPaths(toolRoot);
  const { Agent, setGlobalDispatcher } = await import(pathToFileURL(require.resolve('undici')).href);
  const dispatcher = new Agent({ connect: { ca: cert } });
  setGlobalDispatcher(dispatcher);
  let backendPort = options.backendPort;
  if (backendPort === undefined) {
    const reservation = createTcpServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    backendPort = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  }
  const server = createHttpsServer({ cert, key: await readFile(key) }, (request, response) => {
    const forwarded = requestHttp({ hostname: '127.0.0.1', port: backendPort, path: request.url,
      method: request.method, headers: request.headers }, upstream => {
      response.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(response);
    });
    forwarded.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(forwarded);
  });
  const publicPort = options.origin === undefined ? 0 : Number(new URL(options.origin).port);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(publicPort, '127.0.0.1', resolve); });
  const origin = `https://127.0.0.1:${server.address().port}`;
  if (options.origin !== undefined) assert.equal(origin, options.origin);
  await writeFile(join(state, 'test-gateway.json'), JSON.stringify({ origin, backendPort }), { mode: 0o600 });
  return { origin, backendPort, async close() {
    await dispatcher.close();
    await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
  } };
}

/** Ordinary application credentials; the host never substitutes a synthetic runtime identity. */
export async function openSodaHttpClient({ toolRoot, origin, bootstrapUrl, issueOpenUrl, actors }, label) {
  const { require } = sodaToolPaths(toolRoot);
  const { deriveCsrfToken } = await import(pathToFileURL(require.resolve('@canlang/identity')).href);
  const actor = actors.find(candidate => candidate.label === label);
  assert.ok(actor, `missing ordinary seeded actor ${label}`);
  const cookies = new Map();
  const request = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    if (init.method && init.method !== 'GET') headers.set('origin', origin);
    const response = await fetch(new URL(path, origin), { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';', 1)[0], offset = pair.indexOf('=');
      cookies.set(pair.slice(0, offset), pair.slice(offset + 1));
    }
    return response;
  };
  const openUrl = issueOpenUrl ? await issueOpenUrl() : bootstrapUrl;
  if (openUrl) assert.equal((await request(openUrl)).status, 303);
  const pre = await (await request('/auth/login')).json();
  assert.equal((await request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: actor.email, password: actor.password, _presession: pre.preSessionToken }) })).status, 200);
  const csrf = await deriveCsrfToken(decodeURIComponent(cookies.get('can_session')));
  const json = { 'content-type': 'application/json', 'x-csrf-token': csrf };
  const teams = await (await request('/auth/teams')).json();
  assert.ok(teams.teams.length > 0, 'selected actor needs its real team membership');
  assert.equal((await request('/auth/select-team', { method: 'POST', headers: json,
    body: JSON.stringify({ team: teams.teams[0].team_id, _csrf: csrf }) })).status, 200);
  const grantResponse = await request('/mcp/grants', { method: 'POST', headers: json,
    body: JSON.stringify({ client_id: 'soda-runtime-native-witness' }) });
  assert.equal(grantResponse.status, 200);
  const { token } = await grantResponse.json();
  let rpcId = 0;
  const rpc = async (method, params) => {
    const response = await request('/mcp', { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    assert.equal(response.status, 200, `${method} HTTP`);
    const envelope = await response.json();
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
    return envelope.result;
  };
  const discovered = await rpc('tools/list', {});
  assert.ok(discovered.tools.some(tool => tool.name === 'SodaRuntime.Entry.read'), 'actual compiled read tool');
  return {
    request,
    async attempt(operation, inputs, id = operationId()) {
      const response = await request(`/api/operations/SodaRuntime.${operation}`, { method: 'POST', headers: json,
        body: JSON.stringify({ operation_id: id, inputs }) });
      return { status: response.status, body: await response.json() };
    },
    async mutate(operation, inputs, id = operationId()) {
      const result = await this.attempt(operation, inputs, id);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.status, 'committed', JSON.stringify(result.body));
      return result.body;
    },
    async entries() {
      const result = await rpc('tools/call', { name: 'SodaRuntime.Entry.read', arguments: {} });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const body = result.structuredContent ?? JSON.parse(result.content.find(value => value.type === 'text').text);
      assert.ok(Array.isArray(body.records), JSON.stringify(body));
      return body.records;
    },
    async upload(entry) {
      const uploadId = operationId();
      const response = await request('/files/intents', { method: 'POST', headers: json,
        body: JSON.stringify({ upload_id: uploadId, operation: 'SodaRuntime.attach', field: '/attachment',
          arguments: { entry: { id: entry.id, version: String(entry.version) } },
          name: 'retained.pdf', type: 'application/pdf', size: String(pdf.length) }) });
      const grant = await response.json(); assert.equal(response.status, 200, JSON.stringify(grant));
      const uploaded = await request(grant.content, { method: 'PUT', headers: {
        'content-type': 'application/octet-stream', 'x-csrf-token': csrf, 'upload-offset': '0' }, body: pdf });
      assert.equal(uploaded.status, 200, await uploaded.clone().text());
      assert.equal((await uploaded.json()).complete, true);
      const finalized = await request(grant.finalize, { method: 'POST', headers: json,
        body: JSON.stringify({ upload_id: uploadId, bytes_digest: `sha256:${createHash('sha256').update(pdf).digest('hex')}` }) });
      const result = await finalized.json(); assert.equal(finalized.status, 200, JSON.stringify(result));
      assert.equal(typeof result.file, 'string');
      await this.mutate('attach', { entry: { id: entry.id, version: String(entry.version) }, attachment: { id: result.file } });
      return result.file;
    },
  };
}

/** Called by the actual native process/container proof after the owning runtime is assembled. */
export async function verifySodaApplication({ start, stop, replaceContainer, state }, toolRoot) {
  const label = `Soda durable ${randomBytes(8).toString('hex')}`;
  let runtime;
  let entryId;
  let authenticated;
  let authenticatedOrigin;
  const authorize = async () => {
    if (authenticated) {
      assert.equal(runtime.origin, authenticatedOrigin, 'replacement must preserve the external application origin');
      return authenticated;
    }
    authenticatedOrigin = runtime.origin;
    authenticated = {
      owner: await openSodaHttpClient({ ...runtime, toolRoot }, 'Ava'),
      member: await openSodaHttpClient({ ...runtime, toolRoot }, 'Ben'),
      foreign: await openSodaHttpClient({ ...runtime, toolRoot }, 'Cal'),
    };
    return authenticated;
  };
  const download = async (clients) => {
    const path = `/files/read/SodaRuntime.Entry/${entryId}/attachment`;
    const allowed = await clients.owner.request(path);
    assert.equal(allowed.status, 200, await allowed.clone().text());
    assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), pdf);
    const page = await clients.owner.request('/');
    assert.equal(page.status, 200, 'actual authenticated source page');
    assert.ok((await page.text()).includes(label), 'source page must show the durable app record');
    assert.equal((await clients.member.request(path)).status, 404, 'same-team field policy must deny private file');
    const foreignStatus = (await clients.foreign.request(path)).status;
    assert.ok([403, 404].includes(foreignStatus), `foreign-team file must remain undisclosed (HTTP ${foreignStatus})`);
  };
  try {
    runtime = await start();
    const clients = await authorize();
    const created = await clients.owner.mutate('Entry.create', { label });
    assert.equal(created.records.length, 1, JSON.stringify(created));
    const entry = created.records[0]; entryId = entry.id;
    const updates = [`${label} A`, `${label} B`];
    const raced = await Promise.all(updates.map(next => clients.owner.attempt('Entry.update', {
      record: { id: entry.id, version: String(entry.version) }, label: next,
    })));
    assert.deepEqual(raced.map(result => result.status).sort(), [200, 409], 'one concurrent writer must win the original record version');
    const winner = raced.findIndex(result => result.status === 200);
    const updated = (await clients.owner.entries()).find(record => record.id === entryId);
    assert.equal(updated.data.label, updates[winner]);
    assert.notEqual(updated.version, entry.version);
    const stale = await clients.owner.attempt('Entry.update', { record: { id: entry.id, version: String(entry.version) }, label: 'Rejected stale change' });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal((await clients.owner.entries()).find(record => record.id === entryId).data.label, updates[winner]);
    await clients.owner.upload(updated);
    await download(clients);
    const current = (await clients.owner.entries()).find(record => record.id === entryId);
    assert.ok(current);
    const due = Date.now() + 15000;
    const armed = await clients.owner.mutate('arm', { entry: { id: current.id, version: String(current.version) }, due: new Date(due).toISOString() });
    assert.ok(armed);
    await stop(runtime); runtime = undefined;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, due + 250 - Date.now())));
    runtime = await start();
    const restarted = await authorize();
    await download(restarted);
    const until = Date.now() + 30000;
    let observed;
    while (Date.now() < until) {
      observed = (await restarted.owner.entries()).find(record => record.id === entryId);
      if (observed?.data.ticks === '1') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(observed?.data.ticks, '1', 'persisted missed schedule must execute exactly once after restart');
    assert.equal(typeof runtime.wake, 'function', 'an actual host scheduler wake is required for replay evidence');
    await runtime.wake();
    await runtime.wake();
    assert.equal((await restarted.owner.entries()).find(record => record.id === entryId)?.data.ticks, '1', 'repeated actual wakes must preserve occurrence receipt');
    if (replaceContainer) {
      for (let replacement = 0; replacement < 2; replacement++) {
        await stop(runtime); runtime = undefined;
        runtime = await replaceContainer();
        const replaced = await authorize();
        await download(replaced);
        assert.equal((await replaced.owner.entries()).find(record => record.id === entryId)?.data.ticks, '1');
      }
    }
    return { d1HttpCrud: true, concurrentOneWinner: true, staleVersionRejected: true, authenticatedPage: true, filesAuthorized: true, filesFieldDenial: true, filesTeamDenial: true,
      fileRestart: true, missedWakeRecovery: true, scheduleOccurrenceOnce: true,
      containerReplacement: Boolean(replaceContainer), state };
  } finally { if (runtime) await stop(runtime); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  throw new Error("This workload must be invoked by the owning native Soda runtime launcher proof; startup alone cannot pass it.");
}
