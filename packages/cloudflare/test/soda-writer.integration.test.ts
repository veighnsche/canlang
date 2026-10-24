/** Production provisioning must leave the native host's private writer fence. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

it('recovers the original native setup after initial receipt publication fails and refuses expired recovery', async () => {
  const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const directory = await mkdtemp(join(root, '.can-soda-setup-recovery-'));
  const input = compiledInput();
  const { startSodaSetup } = createRequire(import.meta.url)(join(root, 'packages/cloudflare/dist/deploy/soda-setup.js')) as
    typeof import('../src/deploy/soda-setup.js');
  const dataDir = join(directory, 'data'), receiptFile = join(directory, 'receipt.json'), tokenFile = join(directory, 'token.json');
  await mkdir(dataDir, { mode: 0o700 });
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const token = { operation: randomUUID(), token: randomUUID() + randomUUID(), expires_at: Math.floor(Date.now() / 1000) + 30 };
  const credentials = { email: 'publication-owner@example.invalid', password: 'Synthetic receipt publication password', timezone: 'UTC' };
  const options = { dataDir, receiptFile, tokenFile, host: '127.0.0.1', port };
  const origin = input.environment.vars.CAN_AUTH_ORIGIN!;
  const local = `http://127.0.0.1:${port}`;
  const occupied = 'private foreign receipt must survive';
  await writeFile(tokenFile, JSON.stringify(token), { mode: 0o600 });
  await writeFile(receiptFile, occupied, { mode: 0o600 });
  let setup: Awaited<ReturnType<typeof startSodaSetup>> | undefined;
  let admin: Awaited<ReturnType<typeof provisionSodaStorage>> | undefined;
  const claim = () => fetch(local + '/setup/claim', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ operation: token.operation, token: token.token, ...credentials }) });
  const context = JSON.stringify({ app: input.descriptor.identity.appName, artifactDigest: input.descriptor.identity.artifactDigest,
    bundleDigest: input.bundle.mixedSha256, storageFingerprint: input.storageFingerprint });
  const admission = { operation: token.operation, tokenHash: createHash('sha256').update(token.token).digest('hex'), context, expiresAt: token.expires_at };
  try {
    setup = await startSodaSetup(input, options);
    const failed = await claim();
    assert.equal(failed.status, 400);
    assert.deepEqual(await failed.json(), { error: 'Setup could not complete. Check the details and setup link.' });
    assert.equal(await readFile(receiptFile, 'utf8'), occupied, 'first publication cannot replace a foreign destination');
    await setup.dispose(); setup = undefined;
    admin = await provisionSodaStorage(input, dataDir);
    const privateClaim = (setupAdmission: typeof admission) => admin!.dispatchUrl('https://private.invalid/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...credentials, setup: setupAdmission }),
    });
    // This refusal before any matching recovery proves the failed HTTP response
    // followed a consumed setup transaction, rather than an empty database.
    assert.equal((await privateClaim({ ...admission, operation: randomUUID() })).status, 400);
    const recovered = await privateClaim(admission);
    assert.equal(recovered.status, 200);
    const original = await recovered.json() as { userId: string; teamId: string; completedAt: number };
    await admin.dispose(); admin = undefined;
    await rm(receiptFile);
    setup = await startSodaSetup(input, options);
    const completed = await claim();
    assert.equal(completed.status, 200);
    const receipt = await completed.json() as import('../src/deploy/soda-setup.js').SodaSetupReceipt;
    assert.equal(receipt.ownerTeam, original.teamId);
    assert.equal(receipt.completedAt, original.completedAt);
    assert.equal(receipt.operation, token.operation);
    const bytes = await readFile(receiptFile, 'utf8');
    assert.deepEqual(JSON.parse(bytes), receipt);
    assert.equal((await lstat(receiptFile)).mode & 0o7777, 0o600);
    assert.ok(!bytes.includes(token.token) && !bytes.includes(credentials.password) && !bytes.includes(credentials.email));
    const replay = await claim();
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), receipt);
    const wait = Math.max(0, (token.expires_at + 1) * 1000 - Date.now());
    await new Promise(resolve => setTimeout(resolve, wait));
    assert.equal((await claim()).status, 400, 'a running setup refuses matching recovery after token expiry');
    assert.equal(await readFile(receiptFile, 'utf8'), bytes);
    await setup.dispose(); setup = undefined;
    await assert.rejects(startSodaSetup(input, options), /expired/);
    admin = await provisionSodaStorage(input, dataDir);
    assert.deepEqual(await bootstrapOwner(admin, credentials), { userId: original.userId, teamId: original.teamId });
  } finally { await setup?.dispose(); await admin?.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

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

it('retains custom D1 commits after lost durability acknowledgements without replaying SQL', async () => {
  const { createRequire } = await import('node:module');
  const { Miniflare } = await import('miniflare');
  const { SODA_D1_SOURCE } = createRequire(import.meta.url)(fileURLToPath(
    new URL('../dist/runtime/soda-d1.js', import.meta.url))) as { SODA_D1_SOURCE: string };
  const directory = await mkdtemp(join(fileURLToPath(new URL('../../../', import.meta.url)), '.can-soda-d1-fault-'));
  // The provider is unchanged. This fixture preserves real workerd SQL,
  // transaction, sync and bookmark receivers and loses only the later reply.
  const script = SODA_D1_SOURCE + `
export class FaultD1 extends D1DatabaseObject {
 constructor(state) {
  const fault={mode:null}, actual=state.storage;
  super({storage:{sql:actual.sql,transactionSync:callback=>actual.transactionSync(callback),
   sync:async()=>{await actual.sync();if(fault.mode==='sync'){fault.mode=null;throw new Error('fixture post-sync reply lost');}},
   getCurrentBookmark:async()=>{const bookmark=await actual.getCurrentBookmark();if(fault.mode==='bookmark'){fault.mode=null;throw new Error('fixture post-bookmark reply lost');}return bookmark;}}});
  this.fault=fault;this.executions=0;
 }
 query(query,format) {
  if(/^UPDATE effects SET value=value\\+1/.test(query.sql))this.executions++;
  const marker=query.sql.match(/fixture:(sync|bookmark|response)/);
  const result=super.query(query,format);
  if(marker)this.fault.mode=marker[1];
  return result;
 }
 async fetch(request) {
  const response=await super.fetch(request);
  const headers=new Headers(response.headers);headers.set('x-fixture-mutation-executions',String(this.executions));
  if(this.fault.mode==='response'){this.fault.mode=null;headers.delete('x-cf-d1-session-commit-token');return new Response('fixture response lost',{status:503,headers});}
  return new Response(response.body,{status:response.status,headers});
 }
}
`;
  const options = { modules: true as const, compatibilityDate: '2026-07-15', script,
    bindings: { RESOURCE: 'actual-custom-d1' },
    durableObjects: { DATABASE: { className: 'FaultD1', useSQLite: true } },
    durableObjectsPersist: join(directory, 'persist') };
  let runtime: InstanceType<typeof Miniflare> | undefined;
  const query = (body: unknown) => runtime!.dispatchFetch('https://private.invalid/query', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const counter = async (id: string): Promise<number> => {
    const response = await query({ sql: 'SELECT value FROM effects WHERE id=?', params: [id] });
    assert.equal(response.status, 200);
    const result = await response.json() as Array<{ success: boolean; results: Array<{ value: number }> }>;
    assert.equal(result[0]?.success, true);
    assert.equal(result[0]?.results.length, 1);
    return result[0]!.results[0]!.value;
  };
  try {
    runtime = new Miniflare(options);
    const setup = await query([
      { sql: 'CREATE TABLE effects (id TEXT PRIMARY KEY, value INTEGER NOT NULL)' },
      ...['sync', 'bookmark', 'response', 'rollback'].map(id => ({ sql: 'INSERT INTO effects VALUES (?,0)', params: [id] })),
    ]);
    assert.equal(setup.status, 200);
    assert.ok((await setup.json() as Array<{ success: boolean }>).every(result => result.success));
    for (const fault of ['sync', 'bookmark', 'response']) {
      const failed = await query({ sql: `UPDATE effects SET value=value+1 WHERE id=? /* fixture:${fault} */`, params: [fault] });
      assert.equal(failed.headers.get('x-fixture-mutation-executions'), '1', 'one execution in this fresh host');
      assert.equal(failed.headers.get('x-cf-d1-session-commit-token'), null, 'lost acknowledgement supplies no commit token');
      if (fault === 'response') {
        assert.equal(failed.status, 503);
        assert.equal(await failed.text(), 'fixture response lost');
      } else {
        assert.equal(failed.status, 200);
        const body = await failed.json() as { success: boolean; error: string };
        assert.equal(body.success, false);
        assert.match(body.error, /fixture post-(?:sync|bookmark) reply lost/);
      }
      assert.equal(await counter(fault), 1, 'failure is not proof of rollback and must not trigger SQL replay');
      await runtime.dispose(); runtime = undefined;
      runtime = new Miniflare(options);
      assert.equal(await counter(fault), 1, 'committed effects survive a fresh workerd host');
    }
    const failed = await query([
      { sql: 'UPDATE effects SET value=value+1 WHERE id=?', params: ['rollback'] },
      { sql: 'INSERT INTO deliberately_missing_table VALUES (1)' },
    ]);
    assert.equal(failed.status, 200);
    assert.equal((await failed.json() as { success: boolean }).success, false);
    assert.equal(failed.headers.get('x-cf-d1-session-commit-token'), null);
    assert.equal(failed.headers.get('x-fixture-mutation-executions'), '1');
    assert.equal(await counter('rollback'), 0, 'native SQL failure rolls the whole transaction back');
    await runtime.dispose(); runtime = undefined;
    runtime = new Miniflare(options);
    assert.equal(await counter('rollback'), 0);
    for (const fault of ['sync', 'bookmark', 'response']) assert.equal(await counter(fault), 1);
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('recovers the original setup through the native admin and custom D1 after lost batch and recovery acknowledgements', async () => {
  const { createRequire } = await import('node:module');
  const { spawn } = await import('node:child_process');
  const { mkdir, open } = await import('node:fs/promises');
  const { startSodaWorker } = createRequire(import.meta.url)(fileURLToPath(
    new URL('../dist/deploy/soda-workerd.js', import.meta.url))) as typeof import('../src/deploy/soda-workerd.js');
  const directory = await mkdtemp(join(fileURLToPath(new URL('../../../', import.meta.url)), '.can-soda-native-setup-'));
  const admin = await readFile(new URL('../dist/host/soda-admin.worker.js', import.meta.url), 'utf8');
  const inspect = `
async function snapshot(db){
 const claim=await db.prepare('SELECT c.user_id,c.team_id,c.membership_id,s.operation,s.token_hash,s.context,s.completed_at FROM identity_bootstrap_claim c JOIN identity_setup_claim s ON s.slot=c.slot WHERE c.slot=1').first();
 const counts={};
 for(const table of ['identity_bootstrap_claim','identity_setup_claim','identity_users','identity_teams','identity_memberships'])
  counts[table]=await db.prepare('SELECT COUNT(*) AS count FROM '+table).first('count');
 return Response.json({claim,counts});
}`;
  const faultEntry = `import admin from './admin.js';
${inspect}
let committedBatches=0,failedReads=0;
function failRecovery(statement){return new Proxy(statement,{get(target,key){
 if(key==='bind')return(...args)=>failRecovery(target.bind(...args));
 if(key==='first')return async()=>{failedReads++;throw new Error('fixture recovery acknowledgement lost');};
 const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
}});}
export default {async fetch(request,env){
 if(new URL(request.url).pathname==='/snapshot')return snapshot(env.DB);
 const db={exec:sql=>env.DB.exec(sql),prepare:sql=>{
  const statement=env.DB.prepare(sql);
  return committedBatches===1&&failedReads===0&&sql.includes('FROM identity_bootstrap_claim')?failRecovery(statement):statement;
 },batch:async statements=>{await env.DB.batch(statements);committedBatches++;throw new Error('fixture batch acknowledgement lost');}};
 const response=await admin.fetch(request,{DB:db});
 const headers=new Headers(response.headers);headers.set('x-fixture-committed-batches',String(committedBatches));headers.set('x-fixture-failed-recovery-reads',String(failedReads));
 return new Response(response.body,{status:response.status,headers});
}};`;
  const recoveredEntry = `import admin from './admin.js';
${inspect}
export default {fetch(request,env){return new URL(request.url).pathname==='/snapshot'?snapshot(env.DB):admin.fetch(request,env);}};`;
  let running: { dispose(): Promise<void>; dispatchUrl: Awaited<ReturnType<typeof startSodaWorker>>['dispatchUrl'] } | undefined;
  const start = async (entry: string) => {
    const file = await open(join(directory, '.writer-lock'), 'a+', 0o600);
    const holder = spawn('sh', ['-c', 'flock -n 3 || exit 1; printf "locked\\n"; exec cat'],
      { stdio: ['pipe', 'pipe', 'pipe', file.fd] });
    const closed = new Promise<void>(resolve => holder.once('close', () => resolve()));
    try {
      const acknowledgement = await Promise.race([
        new Promise<string>(resolve => holder.stdout!.once('data', (bytes: Buffer) => resolve(String(bytes)))),
        closed.then(() => { throw new Error('Native setup writer fence unavailable'); }),
      ]);
      assert.equal(acknowledgement, 'locked\n');
      holder.stdin!.end(); await closed;
      const worker = await startSodaWorker({ workerName: 'native-setup-recovery', compatibilityDate: '2026-07-15',
        mainModule: 'entry.js', modules: { 'entry.js': entry, 'admin.js': admin },
        d1Databases: [{ binding: 'DB', id: 'native-setup-identity' }], d1Persist: join(directory, 'd1') }, file.fd);
      return { dispatchUrl: worker.dispatchUrl, async dispose() { try { await worker.dispose(); } finally { await file.close(); } } };
    } catch (error) { holder.stdin!.end(); await closed; await file.close(); throw error; }
  };
  const credentials = { email: 'native-setup@example.invalid', password: 'Synthetic native setup recovery password', timezone: 'UTC' };
  const setup = { operation: 'native-setup-recovery', tokenHash: createHash('sha256').update('Synthetic native setup token').digest('hex'),
    context: JSON.stringify({ app: 'NativeSetupRecovery', artifact: 'original' }), expiresAt: Math.floor(Date.now() / 1000) + 300 };
  const claim = () => running!.dispatchUrl('https://private.invalid/setup', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...credentials, setup }) });
  type Snapshot = { claim: { user_id: string; team_id: string; membership_id: string; operation: string;
    token_hash: string; context: string; completed_at: number }; counts: Record<string, number> };
  const snapshot = async (): Promise<Snapshot> => {
    const response = await running!.dispatchUrl('https://private.invalid/snapshot');
    assert.equal(response.status, 200); return await response.json() as Snapshot;
  };
  try {
    for (const name of ['d1', 'tmp']) await mkdir(join(directory, name), { mode: 0o700 });
    running = await start(faultEntry);
    const lost = await claim();
    assert.equal(lost.status, 400, 'the real admin refuses an unresolved outcome');
    assert.equal(lost.headers.get('x-fixture-committed-batches'), '1');
    assert.equal(lost.headers.get('x-fixture-failed-recovery-reads'), '1');
    const original = await snapshot();
    assert.ok(original.claim);
    assert.equal(original.claim.operation, setup.operation);
    assert.equal(original.claim.token_hash, setup.tokenHash);
    assert.equal(original.claim.context, setup.context);
    assert.ok(Number.isSafeInteger(original.claim.completed_at));
    assert.ok(Object.values(original.counts).every(count => count === 1), 'one complete setup and first owner committed');
    await running.dispose(); running = undefined;
    // Fresh native process, actual unmodified admin and built-in D1 client:
    // neither the SQL batch nor its injected-failure wrapper is replayed.
    running = await start(recoveredEntry);
    const recovered = await claim();
    assert.equal(recovered.status, 200);
    const owner = await recovered.json() as D1OwnerBootstrapOutcome & { completedAt: number };
    assert.deepEqual(owner, { userId: original.claim.user_id, teamId: original.claim.team_id, completedAt: original.claim.completed_at });
    assert.deepEqual(await snapshot(), original);
    const repeated = await claim();
    assert.equal(repeated.status, 200); assert.deepEqual(await repeated.json(), owner);
    assert.deepEqual(await snapshot(), original);
  } finally { await running?.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);
