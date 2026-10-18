#!/usr/bin/env node
/** Native installed Soda target proof over the actual launcher, actor and source workload. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSodaTestGateway, sodaToolPaths, verifySodaApplication } from './verify-soda-runtime.mjs';

const repo = resolve(fileURLToPath(new URL('../', import.meta.url)));
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const toolRoot = resolve(option('--tool-root') ?? process.env.CAN_INSTALL_ROOT ?? process.env.CAN_TOOL_ROOT ?? join(repo, 'output/install/can'));
const state = resolve(option('--state') ?? join(repo, '.artifacts/soda-application'));
assert.ok(state.startsWith('/home/'), '--state must be task-owned under /home');
await mkdir(state, { recursive: true, mode: 0o700 });
await mkdir(join(state, 'tmp'), { recursive: true, mode: 0o700 });
process.env.TMPDIR = join(state, 'tmp');
process.env.PATH = `${join(toolRoot, 'bin')}:${process.env.PATH ?? ''}`;
const tools = sodaToolPaths(toolRoot);
process.env.CAN_DEV_BIN ??= join(toolRoot, 'bin/can-dev');
process.env.CAN_DEV_RUNTIME_HOST ??= join(toolRoot, 'libexec/dev-server-host/entry.mjs');
const { require } = tools;
const load = specifier => import(pathToFileURL(require.resolve(specifier)).href);
const { startSodaRuntime, provisionSodaStorage } = await load('@canlang/cloudflare/deploy/soda-run');
const { installWorkerdShutdown, superviseWorkerd } = await load('@canlang/cloudflare/deploy/soda-lifetime');
const dataDir = join(state, 'data');

if (process.argv.includes('--serve')) {
  process.exitCode = await superviseWorkerd(fileURLToPath(import.meta.url), ['--child', '--tool-root', toolRoot, '--state', state]);
} else if (process.argv.includes('--child')) {
  const input = JSON.parse(await readFile(join(state, 'input.json'), 'utf8'));
  input.bundle.binaries = Object.fromEntries(Object.entries(input.bundle.binaries).map(([key, bytes]) => [key, Buffer.from(bytes, 'base64')]));
  const seed = JSON.parse(await readFile(join(state, 'actors.json'), 'utf8'));
  let runtime;
  let waking = false;
  let lastWake;
  let timer;
  let wakeTask;
  let startup;
  const uninstall = installWorkerdShutdown(async () => {
    await startup;
    if (timer) clearInterval(timer);
    await wakeTask;
    await runtime?.dispose();
    await writeFile(join(state, 'shutdown.json'), JSON.stringify({ graceful: true }));
  });
  startup = (async () => {
    const gateway = JSON.parse(await readFile(join(state, 'test-gateway.json'), 'utf8'));
    runtime = await startSodaRuntime(input, { dataDir, ownerTeam: seed.probe.teamId, host: '127.0.0.1', port: gateway.backendPort });
    await writeFile(join(state, 'ready.json'), JSON.stringify({ origin: runtime.origin }), { mode: 0o600 });
    timer = setInterval(() => {
      if (waking) return;
      waking = true;
      wakeTask = (async () => {
        let id;
        try { id = await readFile(join(state, 'wake-request'), 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        if (id === lastWake) return;
        await runtime.wake(); lastWake = id;
        await writeFile(join(state, 'wake-result'), id, { mode: 0o600 });
      })().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { waking = false; });
    }, 50);
  })();
  try { await startup; }
  catch (error) { uninstall(); await runtime?.dispose(); throw error; }
} else {
  const gateway = await createSodaTestGateway(toolRoot, state);
  try {
  const { buildSodaBundle } = await load('@canlang/cloudflare/deploy/soda');
  const { CONTRACTS_VERSION } = await load('@canlang/contracts');
  const { seedLocalPreviewActors } = await import('../packages/cloudflare/dist/runtime/native-preview.test-support.js');
  const { PINNED_COMPATIBILITY_DATE } = await import(pathToFileURL(join(tools.cloudflare, 'dist/cli/artifact-defaults.js')).href);
  const source = join(repo, 'scripts/fixtures/soda-runtime.can');
  const raw = execFileSync(tools.compiler, ['compile', '--format=json', '--native-scenario-receipts',
    '--catalog', join(tools.cloudflare, 'dist/native-catalog.json'), source],
    { cwd: repo, env: process.env, encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  const artifact = JSON.parse(raw);
  const resources = [{ binding: 'DB', kind: 'd1', logicalName: 'soda-test-identity' },
    { binding: 'STATE_DB', kind: 'd1', logicalName: 'soda-test-state' }];
  const descriptor = { identity: { appName: 'SodaRuntime',
    sourceRevision: `sha256:${createHash('sha256').update(await readFile(source)).digest('hex')}`,
    languageVersion: artifact.language_version, compilerVersion: artifact.tool_version, contractsVersion: CONTRACTS_VERSION,
    artifactDigest: createHash('sha256').update(JSON.stringify(artifact)).digest('hex') },
    requiredCapabilities: artifact.requires.map(item => item.capability), resourceBindings: resources, secrets: [], schedules: [] };
  const environment = { environment: 'soda-native-test', resources: resources.map(requirement => ({ requirement,
    resourceId: requirement.binding === 'DB' ? 'soda-test-identity' : 'soda-test-state' })),
    secretsPresent: [], vars: { CAN_AUTH_ORIGIN: gateway.origin } };
  const input = buildSodaBundle(artifact, descriptor, environment, PINNED_COMPATIBILITY_DATE);
  await writeFile(join(state, 'input.json'), JSON.stringify({ ...input, bundle: { ...input.bundle,
    binaries: Object.fromEntries(Object.entries(input.bundle.binaries).map(([key, bytes]) => [key, Buffer.from(bytes).toString('base64')])) } }), { mode: 0o600 });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const provision = await provisionSodaStorage(input, dataDir);
  let seed;
  try {
    try { seed = JSON.parse(await readFile(join(state, 'actors.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      seed = await seedLocalPreviewActors(await provision.getD1Database('DB'));
    }
  } finally { await provision.dispose(); }
  await writeFile(join(state, 'actors.json'), JSON.stringify(seed), { mode: 0o600 });
  const waitFor = async (read, child, limit = 60000) => {
    const deadline = Date.now() + limit;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`actual Soda runtime exited early (${child.exitCode ?? child.signalCode})`);
      try { const result = await read(); if (result !== undefined) return result; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('actual Soda runtime response timed out');
  };
  let podmanFlags;
  let podmanEnv;
  let containerImageId;
  const image = option('--image') ?? 'docker.io/rockylinux/rockylinux:10.2';
  if (process.argv.includes('--containers')) {
    assert.ok(option('--podman-state'), '--containers requires an explicitly released task-owned --podman-state cache');
    const containerState = resolve(option('--podman-state'));
    assert.ok(containerState.startsWith('/home/'));
    podmanFlags = ['--root', join(containerState, 'podman/root'), '--runroot', join(containerState, 'podman/run'), '--tmpdir', join(containerState, 'podman/tmp')];
    podmanEnv = { ...process.env, TMPDIR: join(containerState, 'tmp') };
    containerImageId = execFileSync('podman', [...podmanFlags, 'image', 'inspect', '--format', '{{.Id}}', image], { env: podmanEnv, encoding: 'utf8' }).trim();
  }
  let replacement = 0;
  const start = async (container = false) => {
    await rm(join(state, 'ready.json'), { force: true });
    await rm(join(state, 'shutdown.json'), { force: true });
    await rm(join(state, 'wake-request'), { force: true });
    await rm(join(state, 'wake-result'), { force: true });
    const containerName = container ? `can-soda-witness-${process.pid}-${replacement++}` : undefined;
    const executable = container ? 'podman' : tools.node;
    const args = container ? [...podmanFlags, 'run', '--rm', '--name', containerName, '--network', 'host', '--security-opt', 'label=disable',
      '--volume', `${join(repo, 'scripts')}:/proof:ro`, '--volume', `${toolRoot}:${toolRoot}:ro`, '--volume', `${state}:${state}:rw`,
      '--env', `TMPDIR=${join(state, 'tmp')}`, '--workdir', '/proof', image, tools.node, '/proof/verify-soda-host.mjs',
      '--serve', '--tool-root', toolRoot, '--state', state]
      : [fileURLToPath(import.meta.url), '--serve', '--tool-root', toolRoot, '--state', state];
    const child = spawn(executable, args, { cwd: repo, env: container ? podmanEnv : process.env, stdio: ['ignore', 'inherit', 'inherit'] });
    const closed = once(child, 'close');
    let ready;
    try { ready = await waitFor(async () => JSON.parse(await readFile(join(state, 'ready.json'), 'utf8')), child); }
    catch (error) {
      if (containerName) {
        try { execFileSync('podman', [...podmanFlags, 'stop', '--time', '15', containerName], { env: podmanEnv, stdio: 'ignore' }); } catch { child.kill('SIGTERM'); }
      } else child.kill('SIGTERM');
      await closed; throw error;
    }
    return { ...ready, actors: seed.actors, child, closed, containerName, wake: async () => {
      const id = randomUUID(); await writeFile(join(state, 'wake-request'), id, { mode: 0o600 });
      await waitFor(async () => (await readFile(join(state, 'wake-result'), 'utf8')) === id ? true : undefined, child);
    } };
  };
  const stop = async runtime => {
    if (runtime.containerName) execFileSync('podman', [...podmanFlags, 'stop', '--time', '15', runtime.containerName], { env: podmanEnv, stdio: 'inherit' });
    else runtime.child.kill('SIGTERM');
    const timer = setTimeout(() => runtime.child.kill('SIGKILL'), 20000);
    try {
      const [code, signal] = await runtime.closed;
      assert.equal(code, 0, `actual Soda shutdown failed (${signal})`);
      assert.equal(JSON.parse(await readFile(join(state, 'shutdown.json'), 'utf8')).graceful, true);
    } finally { clearTimeout(timer); }
  };
  const results = await verifySodaApplication({ start, stop, state, ...(podmanFlags ? { replaceContainer: () => start(true) } : {}) }, toolRoot);
  if (containerImageId) results.containerImage = containerImageId;
  await writeFile(join(state, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  } finally { await gateway.close(); }
}
