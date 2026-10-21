/** Native serving and provisioning; compiled application execution stays in workerd. */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { lstat, mkdir, open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { startSodaWorker, type SodaWorker } from './soda-workerd.js';
import { getSodaStorageFingerprint, preflightSodaDeployment } from './soda.js';
import type { SodaBundle } from './soda.js';
import { DEFAULT_FILE_POLICY } from '@canlang/files/upload';
import { SESSION_COOKIE_NAME, PRESESSION_COOKIE_NAME } from '@canlang/identity';
import { artifactNeedsFiles } from '../runtime/artifact.js';

/** Use the native kernel lock, so crashes release it without stale-lock recovery. */
async function acquireWriter(dataDir: string): Promise<() => Promise<void>> {
  if (!isAbsolute(dataDir)) throw new Error('Soda data directory must be absolute');
  if (!(await realpath(dataDir)).startsWith('/home/')) throw new Error('Soda retained storage must be under /home');
  const stat = await lstat(dataDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new Error('Soda requires a private existing data mount owned by the current user');
  // Validate the inode we actually lock. Never adopt an unsafe existing file,
  // follow a link, or let flock create it with the caller's default umask.
  const file = await open(join(dataDir, '.writer-lock'),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  let child;
  try {
    const lock = await file.stat();
    if (!lock.isFile() || lock.uid !== process.getuid?.() || (lock.mode & 0o7777) !== 0o600)
      throw new Error('Soda writer lock must be a private regular file owned by the current user (mode 0600)');
    // The child inherits this checked descriptor, avoiding a pathname reopen.
    // Its shared open-file description retains the kernel lock until disposal.
    child = spawn('sh', ['-c', 'flock --nonblock 3 || exit $?; printf "locked\\n"; exec cat'],
      { stdio: ['pipe', 'pipe', 'pipe', file.fd] });
  } finally { await file.close(); }
  const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => reject(new Error('Soda data lock is unavailable or the data already has a writer')));
      child.stdout!.once('data', bytes => String(bytes) === 'locked\n' ? resolve() : reject(new Error('Invalid Soda writer lock acknowledgement')));
    });
  } catch (error) { child.stdin!.end(); await closed; throw error; }
  return async () => { child.stdin!.end(); await closed; };
}

async function prepareStorage(input: SodaBundle, dataDir: string): Promise<void> {
  preflightSodaDeployment(input.artifact, input.descriptor, input.environment);
  if (!isAbsolute(dataDir)) throw new Error('Soda data directory must be absolute');
  const stat = await lstat(dataDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Soda requires an existing data mount');
  const storageFingerprint = getSodaStorageFingerprint(input.artifact);
  if (input.storageFingerprint !== storageFingerprint) throw new Error('Soda bundle storage fingerprint differs from its artifact');
  const resources = input.environment.resources.map(item => [item.requirement.binding, item.resourceId]).sort();
  const identity = JSON.stringify({ schema: 'canlang.soda.storage.v2', app: input.descriptor.identity.appName,
    storageFingerprint, resources });
  const legacyIdentity = JSON.stringify({ schema: 'canlang.soda.storage.v1', app: input.descriptor.identity.appName,
    artifactDigest: input.descriptor.identity.artifactDigest, resources });
  const path = join(dataDir, 'storage.json');
  try {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(identity); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readFile(path, 'utf8');
    if (existing !== identity) {
      if (existing !== legacyIdentity) throw new Error('Soda data identity differs; migration/restore must be explicit');
      // Only the exact legacy artifact can attest the schema of retained data.
      // The writer fence is held; atomically seed v2 before admitting updates.
      const staged = join(dataDir, `storage-${randomBytes(12).toString('hex')}.json`);
      const file = await open(staged, 'wx', 0o600);
      try { await file.writeFile(identity); await file.sync(); } finally { await file.close(); }
      await rename(staged, path);
    }
  }
  for (const name of ['d1', 'objects', 'tmp']) await mkdir(join(dataDir, name), { recursive: true, mode: 0o700 });
}

function d1Databases(input: SodaBundle) {
  return input.environment.resources.filter(item => item.requirement.kind === 'd1')
    .map(item => ({ binding: item.requirement.binding, id: item.resourceId }));
}

/** Trusted bootstrap/test handoff. Caller disposes before serving; no public fixture route. */
export async function provisionSodaStorage(input: SodaBundle, dataDir: string): Promise<SodaWorker> {
  const release = await acquireWriter(dataDir);
  try {
    await prepareStorage(input, dataDir);
    const dev = await startSodaWorker({ workerName: input.descriptor.identity.appName, compatibilityDate: input.compatibilityDate,
    compatibilityFlags: input.compatibilityFlags, d1Databases: d1Databases(input),
    d1Persist: join(dataDir, 'd1'),
    mainModule: 'provision.js', modules: { 'provision.js': 'export default {fetch(){return new Response(null,{status:404});}};' },
 });
    let closing: Promise<void> | undefined;
    return { ...dev, dispose: () => closing ??= (async () => { try { await dev.dispose(); } finally { await release(); } })() };
  } catch (error) { await release(); throw error; }
}

export interface SodaRuntimeOptions {
  readonly dataDir: string;
  readonly ownerTeam: string;
  readonly host?: string;
  readonly port?: number;
}
export interface SodaRuntime {
  readonly origin: string;
  readonly wake: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
}

async function forward(request: IncomingMessage, response: ServerResponse, runtime: SodaWorker, origin: string): Promise<void> {
  const path = request.url ?? '/';
  if (new URL(path, origin).origin !== origin) { response.writeHead(400); response.end(); return; }
  if (new URL(path, origin).pathname.startsWith('/__soda_')) { response.writeHead(404); response.end(); return; }
  const chunks: Buffer[] = []; let bytes = 0;
  const limit = new URL(path, origin).pathname.startsWith('/files/content/') ? DEFAULT_FILE_POLICY.maxBytes : 2_000_000;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += value.length;
    if (bytes > limit) { response.writeHead(413); response.end(); return; }
    chunks.push(value);
  }
  const headers: [string, string][] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]!;
    if (!['host', 'connection', 'transfer-encoding', 'x-soda-control', 'cookie'].includes(name.toLowerCase())) {
      headers.push([name, request.rawHeaders[i + 1]!]);
    }
  }
  // Cookie scope is a hostname boundary, not a port boundary. Even a parent
  // domain cookie must not carry Forgejo authority into the application.
  const cookies = (request.headers.cookie ?? '').split(';').map(value => value.trim())
    .filter(value => [SESSION_COOKIE_NAME, PRESESSION_COOKIE_NAME].includes(value.split('=', 1)[0]!));
  if (cookies.length !== 0) headers.push(['cookie', cookies.join('; ')]);
  const method = request.method ?? 'GET';
  const result = await runtime.dispatchUrl(new URL(path, origin).href, { method, headers, redirect: 'manual',
    ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks) }) });
  response.statusCode = result.status;
  result.headers.forEach((value, name) => {
    if (!['connection', 'transfer-encoding', 'set-cookie'].includes(name.toLowerCase())) response.setHeader(name, value);
  });
  const responseCookies = result.headers.getSetCookie();
  if (responseCookies.length !== 0) response.setHeader('set-cookie', responseCookies);
  response.end(Buffer.from(await result.arrayBuffer()));
}

/** Bindings and retained provider paths belong to this target, never Soda's app domain. */
export async function startSodaRuntime(input: SodaBundle, options: SodaRuntimeOptions): Promise<SodaRuntime> {
  const release = await acquireWriter(options.dataDir);
  try {
    const runtime = await startUnderLock(input, options);
    let closing: Promise<void> | undefined;
    return { ...runtime, dispose: () => closing ??= (async () => {
      try { await runtime.dispose(); } finally { await release(); }
    })() };
  } catch (error) { await release(); throw error; }
}

async function startUnderLock(input: SodaBundle, options: SodaRuntimeOptions): Promise<SodaRuntime> {
  await prepareStorage(input, options.dataDir);
  if (!/^[0-9a-f-]{36}$/i.test(options.ownerTeam)) throw new Error('Soda requires a concrete bootstrapped owner team');
  const databases = d1Databases(input);
  const identity = databases.find(item => item.binding === 'DB');
  const state = databases.find(item => item.binding === 'STATE_DB');
  if (identity === undefined || state === undefined || identity.id === state.id) throw new Error('Soda requires separate declared DB and STATE_DB resources');
  let runtime: SodaWorker | undefined;
  let admitted = false;
  const server = createServer((request, response) => {
    if (!admitted || runtime === undefined) { response.writeHead(503); response.end(); return; }
    void forward(request, response, runtime, origin).catch(() => {
      if (!response.headersSent) response.writeHead(502); response.end('Runtime request failed');
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(options.port ?? 8080, options.host ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') { await closeServer(server); throw new Error('Soda listener address unavailable'); }
  const origin = options.port === 0 ? `http://127.0.0.1:${address.port}` : input.environment.vars.CAN_AUTH_ORIGIN!;
  if (options.port === 0 && artifactNeedsFiles(input.artifact)) {
    await closeServer(server);
    throw new Error('Soda File receivers require a configured HTTPS proxy origin and a fixed backend port');
  }
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) { await closeServer(server); throw new Error('Invalid Soda authentication origin'); }
  const control = randomBytes(32).toString('base64url');
  const keyPath = join(options.dataDir, 'form-key');
  let key: string;
  try {
    key = randomBytes(32).toString('base64url');
    await writeFile(keyPath, key, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { await closeServer(server); throw error; }
    key = await readFile(keyPath, 'utf8');
  }
  let closing: Promise<void> | undefined;
  const dispose = (): Promise<void> => closing ??= (async () => {
    admitted = false;
    try { await closeServer(server); } finally { await runtime?.dispose(); }
  })();
  try {
    runtime = await startSodaWorker({ workerName: input.descriptor.identity.appName,
      compatibilityDate: input.compatibilityDate, compatibilityFlags: input.compatibilityFlags,
      mainModule: input.bundle.mainModule, modules: input.bundle.modules, binaryModules: input.bundle.binaries,
      d1Databases: databases, d1Persist: join(options.dataDir, 'd1'),
      durableObjects: [{ binding: 'SODA_APPLICATION', className: 'SodaApplication', useSQLite: true }],
      durableObjectsPersist: join(options.dataDir, 'objects'),
      vars: { ...input.environment.vars, CAN_AUTH_ORIGIN: origin, CAN_DEPLOYMENT_BASE: origin,
        CAN_STATE_OWNER: options.ownerTeam, CAN_STATE_INITIALIZE_FRESH: true,
        CAN_FORM_BINDING_KEY: key, SODA_CONTROL_TOKEN: control },
    });
    const ready = await runtime.dispatchUrl(new URL('/__soda_ready', origin).href, { headers: { 'x-soda-control': control } });
    if (ready.status !== 200) throw new Error(`Soda runtime admission refused HTTP ${ready.status}: ${await ready.text()}`);
    admitted = true;
    return { origin, dispose, wake: async () => {
      const response = await runtime!.dispatchUrl(new URL('/__soda_wake', origin).href, { headers: { 'x-soda-control': control } });
      if (response.status !== 200) throw new Error(`Soda work wake failed HTTP ${response.status}`);
    } };
  } catch (error) { await dispose(); throw error; }
}
