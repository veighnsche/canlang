import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = data => createHash('sha256').update(data).digest('hex');
export const successful = commands => commands.length > 0 && commands.every(c => c.status === 'success');
export function runChild(argv, { cwd, timeoutMs = 600000, env = null } = {}) {
  return new Promise(resolve => {
    const start = new Date().toISOString();
    let stdout = '', stderr = '', timedout = false, error = null;
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, detached: process.platform !== 'win32', ...(env ? { env: { ...process.env, ...env } } : {}) });
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.on('error', e => { error = e.message; });
    const timer = setTimeout(() => {
      timedout = true;
      try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeoutMs);
    child.on('close', (exit, signal) => {
      clearTimeout(timer);
      resolve({ argv, cwd, start, end: new Date().toISOString(), exit, signal, timedout, error,
        status: exit === 0 && !timedout && !error ? 'success' : 'failed', stdout, stderr, env });
    });
  });
}
export function testCounts(text) {
  text = text.replace(/\x1b\[[0-9;]*m/g, '');
  const summaries = [...text.matchAll(/^\s*Tests\s+(.+)$/gm)];
  if (summaries.length) {
    const summary = summaries.at(-1)[1];
    const count = name => Number(summary.match(new RegExp('(\\d+)\\s+' + name))?.[1] ?? 0);
    const total = summary.match(/\((\d+)\)/)?.[1];
    const pass = count('passed'), fail = count('failed'), skipped = count('skipped');
    return { tests: total === undefined ? pass + fail + skipped : Number(total), pass, fail, skipped };
  }
  const get = name => {
    const matches = [...text.matchAll(new RegExp('(?:#|ℹ)\\s*' + name + '\\s+(\\d+)', 'g'))];
    return matches.length ? Number(matches.at(-1)[1]) : null;
  };
  return { tests: get('tests'), pass: get('pass'), fail: get('fail'), skipped: get('skipped') };
}
// Profiles whose tests spawn the can-preparation native binary (cold runners have none).
export const NATIVE_PROFILES = ['cloudflare', 'workspace'];
export const NATIVE_TOOLCHAIN = '1.99.0';
export const NATIVE_CRATE = 'packages/cloudflare/preparation';
export function nativeTargetDir(runnerTemp, profile) {
  return path.join(runnerTemp, 'ts-gate-native', profile);
}
export function nativeBinPath(targetDir) {
  return path.join(targetDir, 'debug', process.platform === 'win32' ? 'can-preparation.exe' : 'can-preparation');
}
export function nativePrerequisiteArgv(cwd) {
  const manifest = path.join(cwd, NATIVE_CRATE, 'Cargo.toml');
  return [
    ['rustup', 'toolchain', 'install', NATIVE_TOOLCHAIN, '--profile', 'minimal'],
    ['rustc', `+${NATIVE_TOOLCHAIN}`, '--version'],
    ['cargo', `+${NATIVE_TOOLCHAIN}`, '--version'],
    ['cargo', `+${NATIVE_TOOLCHAIN}`, 'build', '--locked', '--bin', 'can-preparation', '--manifest-path', manifest],
  ];
}
export function shouldSkipGate({ ready, nativeReady, isTest }) {
  return !ready || (!nativeReady && isTest);
}
const producers = {
  values: [], state: ['values', 'contracts'], stdlib: ['values', 'contracts', 'state'],
  identity: ['values', 'contracts'], ui: [], interfaces: ['values', 'contracts', 'identity', 'ui'],
  work: ['values', 'contracts', 'state', 'stdlib'], cloudflare: null, testkit: null, workspace: null,
};
export async function main(env = process.env, cwd = process.cwd()) {
  const dir = env.CI_RECEIPT_DIR;
  if (!dir || !path.isAbsolute(dir) || path.relative(cwd, dir) === '' || !path.relative(cwd, dir).startsWith('..' + path.sep)) {
    throw new Error('CI_RECEIPT_DIR must be an absolute directory outside the source checkout');
  }
  await mkdir(dir, { recursive: true });
  const receipt = { started: new Date().toISOString(), platform: { os: process.platform, arch: process.arch }, output_manifest: [], version: 1, status: 'failed', profile: env.CI_GATE_PROFILE, task_id: env.CI_TASK_ID,
    expected_sha: env.CI_EXPECTED_SHA, source_sha: null, workflow_sha: env.GITHUB_WORKFLOW_SHA ?? null,
    run_id: env.GITHUB_RUN_ID ?? null, attempt: env.GITHUB_RUN_ATTEMPT ?? null,
    run_url: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
    toolversions: {}, lock_sha256: null, commands: [], native_prerequisite: { required: false }, scope: 'Selected profile only; no claim of complete port or critical witness coverage.' };
  async function command(argv, options = {}) {
    const result = await runChild(argv, { cwd, ...options });
    const n = String(receipt.commands.length).padStart(3, '0');
    for (const stream of ['stdout', 'stderr']) {
      const name = `${n}-${stream}.log`;
      await writeFile(path.join(dir, name), result[stream]);
      result[stream + '_log'] = name;
      result[stream + '_sha256'] = hash(result[stream]);
    }
    result.counts = testCounts(result.stdout + '\n' + result.stderr);
    const text = result.stdout.trim();
    delete result.stdout; delete result.stderr;
    receipt.commands.push(result);
    return { ...result, text };
  }
  const skip = (argv, skippedCwd = cwd) => receipt.commands.push({ argv, cwd: skippedCwd, status: 'skipped', reason: 'Required install, producer build, or native prerequisite failed', start: null, end: null, exit: null, signal: null, timedout: false });
  try {
    if (!Object.hasOwn(producers, receipt.profile) || !/^[a-f0-9]{40}$/i.test(env.CI_EXPECTED_SHA ?? '') || !env.CI_TASK_ID) throw new Error('Invalid profile, expected SHA, or task ID');
    const revision = await command(['git', 'rev-parse', 'HEAD']);
    receipt.source_sha = revision.text;
    if (revision.status !== 'success' || revision.text !== env.CI_EXPECTED_SHA) throw new Error('Source SHA does not match expected SHA');
    receipt.lock_sha256 = hash(await readFile(path.join(cwd, 'bun.lock')));
    for (const tool of ['node', 'bun']) {
      const version = await command([tool, '--version']);
      receipt.toolversions[tool] = version.text;
      if (version.status !== 'success') throw new Error(`${tool} version unavailable`);
    }
    if (!/^v24\./.test(receipt.toolversions.node) || receipt.toolversions.bun !== '1.4.2') throw new Error('Gate requires Node 24 and Bun 1.4.2');
    // Fresh CI checkout only: remove generated outputs, never source or native targets.
    for (const entry of await readdir(path.join(cwd, 'packages'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkg = path.join(cwd, 'packages', entry.name);
      await rm(path.join(pkg, 'dist'), { recursive: true, force: true });
      for (const file of await readdir(pkg)) if (file.endsWith('.tsbuildinfo')) await rm(path.join(pkg, file), { force: true });
    }
    let ready = (await command(['bun', 'install', '--frozen-lockfile'])).status === 'success';
    const builds = producers[receipt.profile] === null ? [['bun', 'run', 'build']] : producers[receipt.profile].map(p => ['bun', 'run', '--filter', `@canlang/${p}`, 'build']);
    for (const argv of builds) {
      if (!ready) { skip(argv); continue; }
      ready = (await command(argv)).status === 'success';
    }
    const p = receipt.profile;
    // Pinned native prerequisite (cloudflare/workspace only): isolated --locked debug
    // build of can-preparation into a private target dir; tests receive its path via
    // CAN_PREPARATION_BIN. Target/binary stay outside the checkout and receipt dir.
    let nativeReady = !NATIVE_PROFILES.includes(p);
    let nativeBin = null;
    if (!nativeReady) {
      const targetDir = nativeTargetDir(env.RUNNER_TEMP ?? tmpdir(), p);
      nativeBin = nativeBinPath(targetDir);
      const [install, rustc, cargoV, build] = nativePrerequisiteArgv(cwd);
      const r1 = await command(install, { timeoutMs: 900000 });
      const r2 = await command(rustc);
      const r3 = await command(cargoV);
      const r4 = await command(build, { timeoutMs: 900000, env: { CARGO_TARGET_DIR: targetDir } });
      const crateDir = path.join(cwd, NATIVE_CRATE);
      const shaFile = async f => { try { return hash(await readFile(f)); } catch { return null; } };
      const lock = await shaFile(path.join(crateDir, 'Cargo.lock'));
      const toolchain = await shaFile(path.join(crateDir, 'rust-toolchain.toml'));
      const bin = r4.status === 'success' ? await shaFile(nativeBin) : null;
      nativeReady = r1.status === 'success' && r2.status === 'success' && r3.status === 'success' && r4.status === 'success' && bin !== null;
      receipt.native_prerequisite = { required: true, target_dir: targetDir, bin: nativeBin, lock_sha256: lock, toolchain_sha256: toolchain, bin_sha256: bin, ok: nativeReady };
    }
    const gates = p === 'workspace' ? [
      { argv: ['bun', 'run', 'typecheck'] }, { argv: ['bunx', 'vitest', 'run'], timeoutMs: 900000 },
    ] : [
      { argv: ['bun', 'run', 'typecheck'], cwd: path.join(cwd, 'packages', p) },
      ...(p === 'cloudflare' || p === 'testkit' ? [{ argv: ['bunx', 'vitest', 'run', `packages/${p}/test`] }] : [{ argv: ['bun', 'run', 'test'], cwd: path.join(cwd, 'packages', p) }]),
      ...(p === 'cloudflare' ? [{ argv: ['node', '--test', 'packages/cloudflare/dist/**/*.test.js'] }] : []),
    ];
    if (p === 'values') gates.push({ argv: ['bun', 'run', 'catalog'], cwd: path.join(cwd, 'packages', p) });
    for (const gate of gates) {
      const isTest = gate.argv.includes('test') || gate.argv.includes('--test') || gate.argv.includes('vitest');
      if (shouldSkipGate({ ready, nativeReady, isTest })) { skip(gate.argv, gate.cwd ?? cwd); continue; }
      const options = { cwd: gate.cwd ?? cwd, ...(gate.timeoutMs ? { timeoutMs: gate.timeoutMs } : {}), ...(isTest && nativeBin ? { env: { CAN_PREPARATION_BIN: nativeBin } } : {}) };
      const result = await command(gate.argv, options);
      if (isTest && result.counts.tests !== null && (result.counts.tests === 0 || result.counts.skipped === result.counts.tests)) {
        const recorded = receipt.commands.at(-1);
        recorded.status = 'failed'; recorded.error = 'Known test counts show zero executed tests or all tests skipped';
      }
    }
    await command(['git', 'diff', '--exit-code', 'HEAD']);
    async function manifest(dirPath) {
      for (const entry of await readdir(dirPath, { withFileTypes: true })) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) await manifest(full);
        else if (entry.isFile()) receipt.output_manifest.push({ path: path.relative(cwd, full), sha256: hash(await readFile(full)) });
      }
    }
    for (const entry of await readdir(path.join(cwd, 'packages'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dist = path.join(cwd, 'packages', entry.name, 'dist');
      try { await manifest(dist); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    receipt.output_manifest.sort((a, b) => a.path.localeCompare(b.path));
    receipt.status = successful(receipt.commands) ? 'success' : 'failed';
  } catch (error) { receipt.error = error.message; }
  finally { receipt.end = new Date().toISOString(); await writeFile(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); }
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const receipt = await main(); process.exitCode = receipt.status === 'success' ? 0 : 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
