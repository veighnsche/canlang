import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = data => createHash('sha256').update(data).digest('hex');
export const successful = commands => commands.length > 0 && commands.every(c => c.status === 'success');
export function runChild(argv, { cwd, timeoutMs = 600000 } = {}) {
  return new Promise(resolve => {
    const start = new Date().toISOString();
    let stdout = '', stderr = '', timedout = false, error = null;
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, detached: process.platform !== 'win32' });
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
        status: exit === 0 && !timedout && !error ? 'success' : 'failed', stdout, stderr });
    });
  });
}
export function testCounts(text) {
  const get = name => {
    const matches = [...text.matchAll(new RegExp('(?:#|ℹ)\\s*' + name + '\\s+(\\d+)', 'g'))];
    return matches.length ? Number(matches.at(-1)[1]) : null;
  };
  return { tests: get('tests'), pass: get('pass'), fail: get('fail'), skipped: get('skipped') };
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
    toolversions: {}, lock_sha256: null, commands: [], scope: 'Selected profile only; no claim of complete port or critical witness coverage.' };
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
  const skip = (argv, skippedCwd = cwd) => receipt.commands.push({ argv, cwd: skippedCwd, status: 'skipped', reason: 'Required install or producer build failed', start: null, end: null, exit: null, signal: null, timedout: false });
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
    const gates = p === 'workspace' ? [
      { argv: ['bun', 'run', 'typecheck'] }, { argv: ['bunx', 'vitest', 'run'], timeoutMs: 900000 },
    ] : [
      { argv: ['bun', 'run', 'typecheck'], cwd: path.join(cwd, 'packages', p) },
      ...(p === 'cloudflare' || p === 'testkit' ? [{ argv: ['bunx', 'vitest', 'run', `packages/${p}/test`] }] : [{ argv: ['bun', 'run', 'test'], cwd: path.join(cwd, 'packages', p) }]),
      ...(p === 'cloudflare' ? [{ argv: ['node', '--test', 'packages/cloudflare/dist/**/*.test.js'] }] : []),
    ];
    if (p === 'values') gates.push({ argv: ['bun', 'run', 'catalog'], cwd: path.join(cwd, 'packages', p) });
    for (const gate of gates) {
      if (!ready) { skip(gate.argv, gate.cwd ?? cwd); continue; }
      const result = await command(gate.argv, gate);
      const isTest = gate.argv.includes('test') || gate.argv.includes('--test') || gate.argv.includes('vitest');
      if (isTest && result.counts.tests !== null && (result.counts.tests === 0 || result.counts.skipped === result.counts.tests)) {
        const recorded = receipt.commands.at(-1);
        recorded.status = 'failed'; recorded.error = 'Known test counts show zero executed tests or all tests skipped';
      }
    }
    await command(['git', 'diff', '--exit-code']);
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
