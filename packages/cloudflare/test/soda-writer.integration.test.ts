/** Production provisioning must leave the native host's private writer fence. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { CONTRACTS_VERSION } from '@canlang/contracts';
import { distribution } from '@canlang/values/distribution';
import { deriveCsrfToken, type D1OwnerBootstrapInput, type D1OwnerBootstrapOutcome } from '@canlang/identity';
import { parseArtifactText } from '../src/runtime/artifact.js';
import { buildSodaBundle } from '../src/deploy/soda.js';
import { provisionSodaStorage, startSodaRuntime } from '@canlang/cloudflare/deploy/soda-run';

/** The stopped administrator owns D1; tests use the same private handoff as the CLI. */
async function bootstrapOwner(runtime: Awaited<ReturnType<typeof provisionSodaStorage>>,
  credentials: D1OwnerBootstrapInput): Promise<D1OwnerBootstrapOutcome> {
  const response = await runtime.dispatchUrl('https://private.invalid/bootstrap', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials),
  });
  assert.equal(response.status, 200);
  const owner = await response.json() as D1OwnerBootstrapOutcome;
  assert.match(owner.userId, /^[0-9a-f-]{36}$/i);
  assert.match(owner.teamId, /^[0-9a-f-]{36}$/i);
  return owner;
}

function compiledInput(workspace?: string, fixtureSource?: string) {
  const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const original = join(root, 'scripts/fixtures/soda-runtime.can');
  const fixture = workspace ? join(workspace, 'soda-runtime.can') : original;
  if (workspace) writeFileSync(fixture, fixtureSource ?? readFileSync(original));
  const { artifact } = parseArtifactText(execFileSync(join(root, 'compiler/target/release/can'), [
    'compile', '--format=json', '--native-scenario-receipts', `--catalog=${fileURLToPath(distribution.catalog)}`, fixture,
  ], { cwd: workspace ?? root, encoding: 'utf8' }), fixture);
  const requirements = [{ binding: 'DB', kind: 'd1' as const, logicalName: 'identity' },
    { binding: 'STATE_DB', kind: 'd1' as const, logicalName: 'state' }];
  return buildSodaBundle(artifact, { identity: { appName: 'SodaRuntime', sourceRevision: 'writer-proof',
    languageVersion: artifact.language_version, compilerVersion: artifact.tool_version,
    contractsVersion: CONTRACTS_VERSION, artifactDigest: createHash('sha256').update(JSON.stringify(artifact)).digest('hex') },
    requiredCapabilities: artifact.requires.map(item => item.capability), resourceBindings: requirements, secrets: [], schedules: [] },
  { environment: 'writer-proof', resources: requirements.map(requirement => ({ requirement, resourceId: requirement.logicalName })),
    secretsPresent: [], vars: { CAN_AUTH_ORIGIN: 'https://writer.soda.test' } }, '2026-07-15');
}

it('creates mode 0600 under umask 022, excludes writers, and recovers genuine D1 bootstrap after release', async () => {
  const directory = await mkdtemp(join(fileURLToPath(new URL('../../../', import.meta.url)), '.can-soda-writer-'));
  const input = compiledInput();
  const previousUmask = process.umask(0o022);
  let runtime: Awaited<ReturnType<typeof provisionSodaStorage>> | undefined;
  try {
    runtime = await provisionSodaStorage(input, directory);
    const lock = await lstat(join(directory, '.writer-lock'));
    assert.equal(lock.mode & 0o7777, 0o600); assert.equal(lock.uid, process.getuid?.()); assert.ok(lock.isFile());
    const credentials = { email: 'writer-owner@example.invalid', password: 'Synthetic writer bootstrap password' };
    const owner = await bootstrapOwner(runtime, credentials);
    await assert.rejects(provisionSodaStorage(input, directory), /already has a writer/);
    await runtime.dispose(); runtime = undefined;
    runtime = await provisionSodaStorage(input, directory);
    assert.deepEqual(await bootstrapOwner(runtime, credentials), owner);
    assert.equal((await lstat(join(directory, '.writer-lock'))).mode & 0o7777, 0o600);
  } finally { process.umask(previousUmask); await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('refuses unsafe existing files and links without changing or adopting their bytes or mode', async () => {
  const directory = await mkdtemp(join(fileURLToPath(new URL('../../../', import.meta.url)), '.can-soda-writer-unsafe-'));
  const input = compiledInput();
  const lock = join(directory, '.writer-lock');
  const target = join(directory, 'other-file');
  try {
    await writeFile(lock, 'unsafe retained lock', { mode: 0o644 }); await chmod(lock, 0o644);
    await assert.rejects(provisionSodaStorage(input, directory), /mode 0600/);
    assert.equal((await lstat(lock)).mode & 0o7777, 0o644); assert.equal(await readFile(lock, 'utf8'), 'unsafe retained lock');
    await rm(lock); await writeFile(target, 'link target', { mode: 0o600 }); await symlink(target, lock);
    await assert.rejects(provisionSodaStorage(input, directory), error => (error as NodeJS.ErrnoException).code === 'ELOOP');
    assert.ok((await lstat(lock)).isSymbolicLink()); assert.equal(await readFile(target, 'utf8'), 'link target');
    await rm(lock); execFileSync('mkfifo', ['-m', '600', lock]);
    await assert.rejects(provisionSodaStorage(input, directory), /private regular file/);
    assert.ok((await lstat(lock)).isFIFO());
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);


it('relays login redirects and session cookies to the browser', async () => {
  const directory = await mkdtemp(join(fileURLToPath(new URL('../../../', import.meta.url)), '.can-soda-login-'));
  const source = readFileSync(new URL('../../../examples/Todo.can', import.meta.url), 'utf8').replace('app Todos', 'app SodaRuntime');
  const input = compiledInput(directory, source);
  let provision: Awaited<ReturnType<typeof provisionSodaStorage>> | undefined;
  let runtime: Awaited<ReturnType<typeof startSodaRuntime>> | undefined;
  try {
    provision = await provisionSodaStorage(input, directory);
    const credentials = { email: 'gateway-owner@example.invalid', password: 'Synthetic gateway login password' };
    const owner = await bootstrapOwner(provision, credentials);
    await provision.dispose(); provision = undefined;
    runtime = await startSodaRuntime(input, { dataDir: directory, ownerTeam: owner.teamId, port: 0 });
    const descriptor = await fetch(runtime.origin + '/auth/login', { headers: { accept: 'text/html' }, redirect: 'manual' });
    assert.equal(descriptor.status, 200);
    const form = await descriptor.text();
    const token = /name="_presession" value="([^"]+)"/.exec(form)?.[1];
    assert.ok(token);
    const response = await fetch(runtime.origin + '/auth/login', { method: 'POST', redirect: 'manual',
      headers: { accept: 'text/html', origin: runtime.origin, cookie: descriptor.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') },
      body: new URLSearchParams({ ...credentials, _presession: token }) });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/auth/select-team');
    const cookies = response.headers.getSetCookie();
    assert.ok(cookies.some(c => c.startsWith('can_session=')));
    assert.ok(cookies.some(c => c.startsWith('can_presession=') && c.includes('Max-Age=0')));
    const teams = await fetch(runtime.origin + '/auth/select-team', { redirect: 'manual', headers: { accept: 'text/html', cookie: cookies.map(c => c.split(';')[0]).join('; ') } });
    assert.equal(teams.status, 200);
    assert.ok((await teams.text()).includes('Select team'));
  } finally { await runtime?.dispose(); await provision?.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);


it('upgrades exact legacy storage, preserves Todo data across a title edit, and refuses schema changes', async () => {
  const directory = await mkdtemp(join(fileURLToPath(new URL('../../../', import.meta.url)), '.can-soda-update-'));
  const source = readFileSync(new URL('../../../examples/Todo.can', import.meta.url), 'utf8').replace('app Todos', 'app SodaRuntime');
  const input = compiledInput(directory, source);
  const titleUpdate = compiledInput(directory, source.replace('title="Todos"', 'title="Retained tasks"'));
  assert.notEqual(input.descriptor.identity.artifactDigest, titleUpdate.descriptor.identity.artifactDigest);
  assert.equal(input.storageFingerprint, titleUpdate.storageFingerprint);
  let provision: Awaited<ReturnType<typeof provisionSodaStorage>> | undefined;
  let runtime: Awaited<ReturnType<typeof startSodaRuntime>> | undefined;
  try {
    provision = await provisionSodaStorage(input, directory);
    const credentials = { email: 'update-owner@example.invalid', password: 'Synthetic retained update password' };
    const owner = await bootstrapOwner(provision, credentials);
    await provision.dispose(); provision = undefined;
    const manifest = join(directory, 'storage.json');
    await writeFile(manifest, JSON.stringify({ schema: 'canlang.soda.storage.v1', app: input.descriptor.identity.appName,
      artifactDigest: input.descriptor.identity.artifactDigest,
      resources: input.environment.resources.map(item => [item.requirement.binding, item.resourceId]).sort() }));
    const legacy = await readFile(manifest, 'utf8');
    await assert.rejects(provisionSodaStorage(titleUpdate, directory), /migration\/restore must be explicit/);
    assert.equal(await readFile(manifest, 'utf8'), legacy);
    runtime = await startSodaRuntime(input, { dataDir: directory, ownerTeam: owner.teamId, port: 0 });
    assert.equal(JSON.parse(await readFile(manifest, 'utf8')).schema, 'canlang.soda.storage.v2');
    const cookies = new Map<string, string>();
    const request = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
      headers.set('origin', runtime!.origin);
      const response = await fetch(runtime!.origin + path, { ...init, headers, redirect: 'manual' });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';', 1)[0]!; const offset = pair.indexOf('=');
        cookies.set(pair.slice(0, offset), pair.slice(offset + 1));
      }
      return response;
    };
    const pre = await (await request('/auth/login')).json() as { preSessionToken: string };
    const login = await request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, _presession: pre.preSessionToken }) });
    assert.equal(login.status, 200);
    const csrf = await deriveCsrfToken(decodeURIComponent(cookies.get('can_session')!));
    const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf };
    assert.equal((await request('/auth/select-team', { method: 'POST', headers,
      body: JSON.stringify({ team: owner.teamId, _csrf: csrf }) })).status, 200);
    const time = Date.now().toString(16).padStart(12, '0');
    const operationId = `${time.slice(0, 8)}-${time.slice(8)}-760a-8f75-6aa1c2abc941`;
    const created = await request('/api/operations/SodaRuntime.Todo.create', { method: 'POST', headers,
      body: JSON.stringify({ operation_id: operationId, inputs: { title: 'Survives a title edit' } }) });
    assert.equal(created.status, 200, await created.text());
    await runtime.dispose(); runtime = undefined;
    runtime = await startSodaRuntime(titleUpdate, { dataDir: directory, ownerTeam: owner.teamId, port: 0 });
    const page = await request('/', { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('Retained tasks'), 'current page title is served');
    assert.ok(html.includes('Survives a title edit'), 'stored application row survives the new artifact');
    await runtime.dispose(); runtime = undefined;
    const before = await readFile(manifest, 'utf8');
    const schemaUpdate = compiledInput(directory, source.replace('done:bool=false', 'priority:int=0, done:bool=false'));
    assert.notEqual(schemaUpdate.storageFingerprint, titleUpdate.storageFingerprint);
    await assert.rejects(startSodaRuntime(schemaUpdate, { dataDir: directory, ownerTeam: owner.teamId, port: 0 }),
      /migration\/restore must be explicit/);
    assert.equal(await readFile(manifest, 'utf8'), before);
    await assert.rejects(provisionSodaStorage({ ...titleUpdate, storageFingerprint: '0'.repeat(64) }, directory),
      /storage fingerprint differs/);
    for (const changedIdentity of [
      { ...titleUpdate, descriptor: { ...titleUpdate.descriptor,
        identity: { ...titleUpdate.descriptor.identity, appName: 'DifferentApp' } } },
      { ...titleUpdate, environment: { ...titleUpdate.environment, resources: titleUpdate.environment.resources.map((item, index) =>
        index === 0 ? { ...item, resourceId: 'different-identity-database' } : item) } },
    ]) await assert.rejects(provisionSodaStorage(changedIdentity, directory), /migration\/restore must be explicit/);
  } finally { await runtime?.dispose(); await provision?.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);
