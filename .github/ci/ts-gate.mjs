import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILES, PLAN_VERSION, NATIVE_PROFILES, NATIVE_CRATE, nativeTargetDir, nativeBinPath, gatePlan, testCounts, executedTests, validToolVersion } from './gate-plan.mjs';

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
export { testCounts, NATIVE_PROFILES, NATIVE_TOOLCHAIN, nativeTargetDir, nativeBinPath, nativePrerequisiteArgv, buildPrerequisiteArgv } from './gate-plan.mjs';
export function shouldSkipGate({ ready, nativeReady, isTest }) {
  return !ready || (!nativeReady && isTest);
}
export async function main(env = process.env, cwd = process.cwd(), { run = runChild } = {}) {
  const dir = env.CI_RECEIPT_DIR;
  if (!dir || !path.isAbsolute(dir) || path.relative(cwd, dir) === '' || !path.relative(cwd, dir).startsWith('..' + path.sep)) {
    throw new Error('CI_RECEIPT_DIR must be an absolute directory outside the source checkout');
  }
  await mkdir(dir, { recursive: true });
  const runnerTemp = path.resolve(env.RUNNER_TEMP ?? tmpdir());
  const receipt = { started: new Date().toISOString(), platform: { os: process.platform, arch: process.arch }, source_dir: cwd, runner_temp: runnerTemp,
    plan_version: PLAN_VERSION, output_manifest: [], version: 1, status: 'failed', profile: env.CI_GATE_PROFILE, task_id: env.CI_TASK_ID,
    expected_sha: env.CI_EXPECTED_SHA, source_sha: null, workflow_sha: env.GITHUB_WORKFLOW_SHA ?? null,
    run_id: env.GITHUB_RUN_ID ?? null, attempt: env.GITHUB_RUN_ATTEMPT ?? null,
    run_url: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
    toolversions: {}, lock_sha256: null, commands: [], native_prerequisite: { required: false }, scope: 'Selected profile only; no claim of complete port or critical witness coverage.' };
  async function command(step) {
    const { argv, cwd, env, timeoutMs } = step;
    const result = await run(argv, { cwd, env, ...(timeoutMs ? { timeoutMs } : {}) });
    Object.assign(result, { id: step.id, argv, cwd, env, isTest: step.isTest });
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
    if (step.isTest && result.status === 'success' && !executedTests(result.counts)) {
      result.status = 'failed'; result.error = 'Test logs lack passing executed tests or report zero/all-skipped/failed tests';
    }
    receipt.commands.push(result);
    return { ...result, text };
  }
  const skip = step => receipt.commands.push({ id: step.id, argv: step.argv, cwd: step.cwd, env: step.env, isTest: step.isTest,
    status: 'skipped', reason: 'Required install, producer build, or native prerequisite failed', start: null, end: null, exit: null, signal: null, timedout: false });
  try {
    if (!PROFILES.includes(receipt.profile) || !/^[a-f0-9]{40}$/i.test(env.CI_EXPECTED_SHA ?? '') || !env.CI_TASK_ID) throw new Error('Invalid profile, expected SHA, or task ID');
    const plan = gatePlan(receipt.profile, cwd, { runnerTemp, platform: process.platform });
    let ready = false;
    let nativeReady = !NATIVE_PROFILES.includes(receipt.profile);
    const nativeResults = [];
    for (const step of plan) {
      if (step.phase === 'install') {
        // Fresh CI checkout only: remove generated outputs, never source or native targets.
        for (const entry of await readdir(path.join(cwd, 'packages'), { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const pkg = path.join(cwd, 'packages', entry.name);
          await rm(path.join(pkg, 'dist'), { recursive: true, force: true });
          for (const file of await readdir(pkg)) if (file.endsWith('.tsbuildinfo')) await rm(path.join(pkg, file), { force: true });
        }
      }
      if ((step.phase === 'build' && !ready) || (step.phase === 'gate' && shouldSkipGate({ ready, nativeReady, isTest: step.isTest }))) {
        skip(step); continue;
      }
      const result = await command(step);
      if (step.id === 'revision') {
        receipt.source_sha = result.text;
        if (result.status !== 'success' || result.text !== env.CI_EXPECTED_SHA) throw new Error('Source SHA does not match expected SHA');
        receipt.lock_sha256 = hash(await readFile(path.join(cwd, 'bun.lock')));
      }
      if (['node-version', 'bun-version', 'rustc-version', 'cargo-version'].includes(step.id)) {
        const tool = step.id.replace('-version', '');
        receipt.toolversions[tool] = result.text;
        if (!validToolVersion(tool, result.text)) {
          const recorded = receipt.commands.at(-1);
          recorded.status = 'failed'; recorded.error = `${tool} version does not match the gate pin`;
          result.status = 'failed';
        }
        if (step.phase === 'preflight' && result.status !== 'success') throw new Error(`${tool} version unavailable or does not match the gate pin`);
      }
      if (step.phase === 'install' || step.phase === 'build') ready = result.status === 'success';
      if (step.phase === 'native') nativeResults.push(result);
      if (step.id === 'native-build') {
        const targetDir = nativeTargetDir(runnerTemp, receipt.profile);
        const nativeBin = nativeBinPath(targetDir);
        const crateDir = path.join(cwd, NATIVE_CRATE);
        const shaFile = async file => { try { return hash(await readFile(file)); } catch { return null; } };
        const lock = await shaFile(path.join(crateDir, 'Cargo.lock'));
        const toolchain = await shaFile(path.join(crateDir, 'rust-toolchain.toml'));
        const bin = result.status === 'success' ? await shaFile(nativeBin) : null;
        nativeReady = successful(nativeResults) && lock !== null && toolchain !== null && bin !== null;
        receipt.native_prerequisite = { required: true, target_dir: targetDir, bin: nativeBin, lock_sha256: lock, toolchain_sha256: toolchain, bin_sha256: bin, ok: nativeReady };
      }
    }
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
    receipt.status = successful(receipt.commands) && nativeReady ? 'success' : 'failed';
  } catch (error) { receipt.error = error.message; }
  finally { receipt.end = new Date().toISOString(); await writeFile(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); }
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const receipt = await main(); process.exitCode = receipt.status === 'success' ? 0 : 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
