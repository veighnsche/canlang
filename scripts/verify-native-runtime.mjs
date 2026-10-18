#!/usr/bin/env node
/** Native workerd proof. Build first; every byte, cache and container store stays under --state /home/…. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('../', import.meta.url)));
const flag = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const state = resolve(flag('--state') ?? join(repo, '.artifacts/native-runtime'));
assert.ok(state.startsWith('/home/'), '--state must be an absolute task-owned path under /home');
await mkdir(state, { recursive: true, mode: 0o700 });
await mkdir(join(state, 'tmp'), { recursive: true, mode: 0o700 });
process.env.TMPDIR = join(state, 'tmp');
const { startLocalDev, startNativeGateway, seedLocalPreviewActors, localPreviewActivationVerdict } =
  await import('../packages/cloudflare/dist/runtime/native-preview.test-support.js');
const { prepareLocalPreviewCapture, captureSingleFileSource, compileCapturedSingleFile } =
  await import('../packages/cloudflare/dist/runtime/native-dev.test-support.js');
const { PINNED_COMPATIBILITY_DATE } = await import('../packages/cloudflare/dist/cli/artifact-defaults.js');
const { deriveCsrfToken } = await import('@canlang/identity');
const storage = join(state, 'd1');
const runtimeBase = { workerName: 'can-native-proof', compatibilityDate: PINNED_COMPATIBILITY_DATE,
  d1Databases: [{ binding: 'DB', id: 'can-native-proof-db' }], d1Persist: storage, d1PersistenceRequired: true };

if (process.argv.includes('--child')) {
  const { superviseWorkerd } = await import('../packages/cloudflare/dist/deploy/soda-lifetime.js');
  process.exitCode = await superviseWorkerd(fileURLToPath(import.meta.url), ['--worker', '--state', state]);
} else if (process.argv.includes('--worker')) {
  const input = JSON.parse(await readFile(join(state, 'input.json'), 'utf8'));
  let worker;
  const bridge = await startNativeGateway();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; shuttingDown = true;
    await bridge.close(); await worker?.dispose();
    await writeFile(join(state, 'shutdown.json'), JSON.stringify({ graceful: true }));
  };
  const { installWorkerdShutdown } = await import('../packages/cloudflare/dist/deploy/soda-lifetime.js');
  installWorkerdShutdown(shutdown);
  try {
    worker = await startLocalDev({ ...runtimeBase, mainModule: input.bundle.mainModule,
      modules: input.bundle.modules,
      binaryModules: Object.fromEntries(Object.entries(input.binaries).map(([key, bytes]) => [key, Buffer.from(bytes, 'base64')])),
      vars: { CAN_AUTH_ORIGIN: bridge.url, CAN_DEPLOYMENT_BASE: bridge.url,
        CAN_FORM_BINDING_KEY: randomBytes(32).toString('base64url') } });
    const verdict = await localPreviewActivationVerdict(input.artifact, input.capture,
      await worker.getD1Database('DB'), 'can-native-proof-db');
    assert.equal(verdict.active, true, JSON.stringify(verdict));
    await bridge.setBackend(worker.backend);
    await writeFile(join(state, 'ready.json'), JSON.stringify({ url: await bridge.issueOpenUrl() }), { mode: 0o600 });
  } catch (error) { await bridge.close(); await worker?.dispose(); throw error; }
} else {
  const { distribution } = await import('@canlang/values/distribution');
  const { buildDeployBundleWithAssets } = await import('../packages/cloudflare/dist/deploy/bundle.js');
  const fixture = join(repo, 'scripts/fixtures/native-runtime.can');
  const source = await readFile(fixture);
  const capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: repo, appPath: fixture,
    compilerPath: flag('--compiler') ?? join(repo, 'compiler/target/debug/can'),
    catalogPath: fileURLToPath(distribution.catalog), helpIndexPath: join(repo, 'docs/specification/CONSTRUCT-HELP.md') }));
  const compiled = await compileCapturedSingleFile(capture);
  assert.equal(compiled.kind, 'artifact', JSON.stringify(compiled));
  const artifact = compiled.artifact;
  assert.deepEqual(await readFile(fixture), source, 'fixture changed during compilation');
  assert.deepEqual(artifact.sources, [{ path: capture.compilerOperand, sha256: capture.sourceSha256 }]);
  assert.ok(artifact.operations.some(operation => operation.name === 'NativeRuntime.Setting.create'));
  const preflight = await startLocalDev({ workerName: 'can-native-preflight', compatibilityDate: PINNED_COMPATIBILITY_DATE,
    mainModule: 'main.js', modules: { 'main.js': 'export default {fetch(){return new Response(null,{status:404});}};' },
    d1Databases: [{ binding: 'DB', id: 'can-native-preflight-db' }] });
  let verdict;
  try { verdict = await localPreviewActivationVerdict(artifact, capture, await preflight.getD1Database('DB'), 'can-native-preflight-db'); }
  finally { await preflight.dispose(); }
  assert.equal(verdict.active, true, JSON.stringify(verdict));
  const evidence = { bundle: buildDeployBundleWithAssets(artifact, { verdict, assets: { browser: true, valuesWasm: false } }) };
  const { binaries, ...bundle } = evidence.bundle;
  await writeFile(join(state, 'input.json'), JSON.stringify({ artifact, capture, bundle,
    binaries: Object.fromEntries(Object.entries(binaries ?? {}).map(([key, bytes]) => [key, Buffer.from(bytes).toString('base64')])) }));
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const provision = await startLocalDev({ ...runtimeBase, mainModule: 'provision.js',
    modules: { 'provision.js': 'export default { fetch() { return new Response(null, {status:404}); } };' } });
  let seed;
  try {
    try { seed = JSON.parse(await readFile(join(state, 'actors.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; seed = await seedLocalPreviewActors(await provision.getD1Database('DB')); }
  } finally { await provision.dispose(); }
  await writeFile(join(state, 'actors.json'), JSON.stringify(seed), { mode: 0o600 });

  // Required storage must visibly reject rather than silently use ephemeral D1.
  const minimal = { ...runtimeBase, mainModule: 'main.js', modules: { 'main.js': 'export default { fetch(){return new Response("ok");} };' } };
  await assert.rejects(startLocalDev({ ...minimal, d1Persist: join(state, 'missing') }), /D1|persist|storage|directory/i);
  const unwritable = join(state, 'unwritable'); await mkdir(unwritable, { recursive: true }); await chmod(unwritable, 0o500);
  try { await assert.rejects(startLocalDev({ ...minimal, d1Persist: unwritable }), /D1|persist|storage|writ/i); }
  finally { await chmod(unwritable, 0o700); }
  await assert.rejects(startLocalDev({ ...minimal, d1Persist: undefined }), /D1|persist|storage|directory/i);

  function operationId() {
    const time = Date.now().toString(16).padStart(12, '0'); const b = randomBytes(10).toString('hex');
    return `${time.slice(0, 8)}-${time.slice(8)}-7${b.slice(0, 3)}-${((parseInt(b[3], 16) & 3) | 8).toString(16)}${b.slice(4, 7)}-${b.slice(7, 19)}`;
  }
  const waitFile = async (file, child) => {
    for (let i = 0; i < 600; i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`runtime exited early with ${child.exitCode}`);
      try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('runtime readiness timed out');
  };
  const ownedChildren = new Set();
  process.once('exit', () => { for (const child of ownedChildren) child.kill('SIGTERM'); });
  async function start(command = process.execPath, args = [fileURLToPath(import.meta.url), '--child', '--state', state]) {
    await rm(join(state, 'ready.json'), { force: true }); await rm(join(state, 'shutdown.json'), { force: true });
    const child = spawn(command, args, { cwd: repo, env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
    ownedChildren.add(child);
    child.once('close', () => ownedChildren.delete(child));
    const closed = once(child, 'close');
    child.once('error', error => console.error(error));
    let ready;
    try { ready = await waitFile(join(state, 'ready.json'), child); }
    catch (error) { child.kill('SIGTERM'); await closed; throw error; }
    const cookies = new Map(); const origin = new URL(ready.url).origin;
    const request = async (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (cookies.size) headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
      if (init.method === 'POST') headers.set('origin', origin);
      const response = await fetch(new URL(path, origin), { ...init, headers, redirect: 'manual' });
      for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';', 1)[0]; const i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
      return response;
    };
    assert.equal((await fetch(origin)).status, 401);
    assert.equal((await request(ready.url)).status, 303);
    const actor = seed.actors.find(actor => actor.label === 'Ava');
    const pre = await (await request('/auth/login')).json();
    assert.equal((await request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: actor.email, password: actor.password, _presession: pre.preSessionToken }) })).status, 200);
    const csrf = await deriveCsrfToken(decodeURIComponent(cookies.get('can_session')));
    const teams = await (await request('/auth/teams')).json();
    assert.equal((await request('/auth/select-team', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ team: teams.teams[0].team_id, _csrf: csrf }) })).status, 200);
    return { child, closed, request, csrf, async stop(container) {
      if (container) execFileSync('podman', [...podmanFlags, 'stop', '--time', '15', container], { stdio: 'inherit', env: podmanEnv });
      else child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
      try { const [code, signal] = await closed; assert.equal(code, 0, `shutdown: ${signal}`);
        assert.equal(JSON.parse(await readFile(join(state, 'shutdown.json'), 'utf8')).graceful, true);
      } finally { clearTimeout(timeout); }
    } };
  }
  let writeId = operationId();
  let writeName = `Acknowledged persistent write ${writeId}`;
  async function check(runtime, create = false) {
    if (create) {
      const response = await runtime.request('/api/operations/NativeRuntime.Setting.create', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': runtime.csrf },
        body: JSON.stringify({ operation_id: writeId, inputs: { name: writeName } }) });
      assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.status, 'committed');
      assert.equal(result.records[0].data.name, writeName);
    }
    const page = await runtime.request('/'); assert.equal(page.status, 200); assert.ok((await page.text()).includes(writeName), 'acknowledged application write did not survive');
  }
  const podmanFlags = ['--root', join(state, 'podman/root'), '--runroot', join(state, 'podman/run'), '--tmpdir', join(state, 'podman/tmp')];
  const podmanEnv = { ...process.env, TMPDIR: join(state, 'tmp') };
  let runtime = await start(); try { await check(runtime, true); } finally { await runtime.stop(); }
  runtime = await start(); try { await check(runtime); } finally { await runtime.stop(); }
  const results = { nativeHttpWrite: true, processRestart: true, gracefulShutdown: true, missingStorageRejected: true, unwritableStorageRejected: true,
    containerReplacement: false, node: process.version, platform: process.platform, arch: process.arch, compatibilityDate: PINNED_COMPATIBILITY_DATE, compatibilityFlags: [],
    sourceSha256: capture.sourceRevision, bundleSha256: bundle.sha256,
    compilerSha256: createHash('sha256').update(await readFile(flag('--compiler') ?? join(repo, 'compiler/target/debug/can'))).digest('hex') };
  const runtimeRequire = createRequire(new URL('../packages/cloudflare/dist/runtime/native-preview.test-support.js', import.meta.url));
  const runtimePackage = runtimeRequire('miniflare/package.json');
  results.miniflare = runtimePackage.version;
  results.workerd = runtimePackage.dependencies.workerd;
  results.compiler = execFileSync(flag('--compiler') ?? join(repo, 'compiler/target/debug/can'), ['--version'], { encoding: 'utf8' }).trim();
  results.os = await readFile('/etc/os-release', 'utf8');
  if (process.argv.includes('--containers')) {
    for (const directory of ['root', 'run', 'tmp']) await mkdir(join(state, 'podman', directory), { recursive: true });
    const image = flag('--image') ?? 'docker.io/rockylinux/rockylinux:10.2';
    execFileSync('podman', [...podmanFlags, 'pull', image], { env: podmanEnv, stdio: 'inherit' });
    const node = realpathSync(process.execPath);
    for (let replacement = 0; replacement < 2; replacement++) {
      const name = `can-native-proof-${process.pid}-${replacement}`;
      runtime = await start('podman', [...podmanFlags, 'run', '--rm', '--name', name, '--network', 'host', '--security-opt', 'label=disable',
        '--volume', `${repo}:${repo}:ro`, '--volume', `${state}:${state}:rw`, '--volume', `${node}:/usr/local/bin/node:ro`,
        '--env', `TMPDIR=${join(state, 'tmp')}`, '--workdir', repo, image,
        '/usr/local/bin/node', join(repo, 'scripts/verify-native-runtime.mjs'), '--child', '--state', state]);
      try {
        if (replacement === 0) { writeId = operationId(); writeName = `Acknowledged persistent write ${writeId}`; await check(runtime, true); }
        else await check(runtime);
      } finally {
        if (replacement === 0) {
          execFileSync('podman', [...podmanFlags, 'kill', '--signal', 'KILL', name], { stdio: 'inherit', env: podmanEnv });
          const [code] = await runtime.closed;
          assert.equal(code, 137, 'abrupt container kill must be observed');
          await assert.rejects(readFile(join(state, 'shutdown.json')), error => error.code === 'ENOENT');
        } else await runtime.stop(name);
      }
    }
    // An existing mounted database made read-only must fail before an HTTP listener is exposed.
    await rm(join(state, 'ready.json'), { force: true });
    assert.throws(() => execFileSync('podman', [...podmanFlags, 'run', '--rm', '--network', 'host', '--security-opt', 'label=disable',
      '--volume', `${repo}:${repo}:ro`, '--volume', `${state}:${state}:rw`, '--volume', `${storage}:${storage}:ro`,
      '--volume', `${node}:/usr/local/bin/node:ro`, '--env', `TMPDIR=${join(state, 'tmp')}`, '--workdir', repo, image,
      '/usr/local/bin/node', join(repo, 'scripts/verify-native-runtime.mjs'), '--child', '--state', state],
      { env: podmanEnv, encoding: 'utf8', timeout: 30000, stdio: 'pipe' }), error =>
      error.status !== 0 && /persist|D1|read-only|storage/i.test(String(error.stderr)));
    await assert.rejects(readFile(join(state, 'ready.json')), error => error.code === 'ENOENT');
    results.containerHttpWrite = true;
    results.abruptContainerRestart = true;
    results.readOnlyContainerStorageRejected = true;
    results.containerReplacement = true;
    results.containerImage = execFileSync('podman', [...podmanFlags, 'image', 'inspect', '--format', '{{.Id}} {{join .RepoDigests " "}}', image], { env: podmanEnv, encoding: 'utf8' }).trim();
  }
  await writeFile(join(state, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
