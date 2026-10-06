import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { PROFILES, PLAN_VERSION, NATIVE_PROFILES, nativeTargetDir, nativeBinPath, gatePlan, testCounts, executedTests, validToolVersion } from './gate-plan.mjs';
const hash = data => createHash('sha256').update(data).digest('hex');
function gh(argv, json = false) {
  const r = spawnSync('gh', argv, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, shell: false });
  if (r.error || r.status !== 0) throw new Error(`gh failed: ${r.error?.message ?? r.stderr}`);
  return json ? JSON.parse(r.stdout) : r.stdout;
}
export async function validateReceipt(receipt, expected, dir) {
  for (const key of ['source_sha','expected_sha']) if (receipt[key] !== expected.sha) throw new Error(`Receipt ${key} mismatch`);
  for (const [key, value] of Object.entries({ workflow_sha: expected.workflowSha, profile: expected.profile, task_id: expected.task, run_id: expected.run, attempt: expected.attempt })) {
    if (String(receipt[key]) !== String(value)) throw new Error(`Receipt ${key} mismatch`);
  }
  if (receipt.version !== 1 || receipt.plan_version !== PLAN_VERSION || receipt.status !== 'success' || receipt.error || !Array.isArray(receipt.commands)) throw new Error('Receipt is not successful or has an unsupported command plan');
  const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value;
  if (!absolute(receipt.source_dir) || !absolute(receipt.runner_temp) || !['linux', 'darwin', 'win32'].includes(receipt.platform?.os)) throw new Error('Bad receipt source, temporary directory, or platform');
  if (!/^[a-f0-9]{64}$/.test(receipt.lock_sha256 ?? '')) throw new Error('Missing lock checksum');
  const plan = gatePlan(expected.profile, receipt.source_dir, { runnerTemp: receipt.runner_temp, platform: receipt.platform.os });
  if (receipt.commands.length !== plan.length) throw new Error('Receipt command coverage mismatch');
  const root = await realpath(dir);
  const logs = new Map();
  const logNames = new Set();
  for (let index = 0; index < plan.length; index++) {
    const c = receipt.commands[index], step = plan[index];
    if (c.id !== step.id || !isDeepStrictEqual(c.argv, step.argv) || c.cwd !== step.cwd || c.isTest !== step.isTest || !isDeepStrictEqual(c.env, step.env)) throw new Error(`Receipt command plan mismatch at ${step.id}`);
    if (c.status !== 'success' || c.exit !== 0 || c.signal || c.timedout || c.error) throw new Error('Receipt contains unsuccessful command');
    const streams = {};
    for (const stream of ['stdout','stderr']) {
      const name = c[`${stream}_log`];
      if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+\.log$/.test(name) || logNames.has(name)) throw new Error('Unsafe or reused log filename');
      logNames.add(name);
      const full = path.join(dir, name);
      if (path.dirname(await realpath(full)) !== root) throw new Error('Log escapes receipt directory');
      const bytes = await readFile(full);
      if (hash(bytes) !== c[`${stream}_sha256`]) throw new Error('Log checksum mismatch');
      streams[stream] = bytes.toString('utf8');
    }
    const counts = testCounts(streams.stdout + '\n' + streams.stderr);
    if (!isDeepStrictEqual(c.counts, counts)) throw new Error(`Recorded test counts disagree with logs at ${step.id}`);
    if (step.isTest && !executedTests(counts)) throw new Error(`No passing executed tests at ${step.id}`);
    logs.set(step.id, streams);
  }
  if (logs.get('revision').stdout.trim() !== expected.sha) throw new Error('Revision log does not prove the expected source SHA');
  if (logs.get('clean-tree').stdout.trim() !== '') throw new Error('Final tree check reported a diff');
  for (const tool of ['node', 'bun', ...(NATIVE_PROFILES.includes(expected.profile) ? ['rustc', 'cargo'] : [])]) {
    const observed = logs.get(`${tool}-version`).stdout.trim();
    if (receipt.toolversions?.[tool] !== observed || !validToolVersion(tool, observed)) throw new Error(`${tool} version proof does not match the gate pin`);
  }
  const np = receipt.native_prerequisite;
  if (NATIVE_PROFILES.includes(expected.profile)) {
    if (!np || np.required !== true || np.ok !== true) throw new Error('Missing or failed native prerequisite');
    for (const key of ['lock_sha256', 'toolchain_sha256', 'bin_sha256']) {
      if (!/^[a-f0-9]{64}$/.test(np[key] ?? '')) throw new Error('Bad native prerequisite hash');
    }
    const target = nativeTargetDir(receipt.runner_temp, expected.profile);
    const binary = nativeBinPath(target, receipt.platform.os);
    const within = (base, child) => { const rel = path.relative(base, child); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };
    if (np.target_dir !== target || np.bin !== binary || within(receipt.source_dir, target) || within(root, target)) throw new Error('Native prerequisite path is not the planned private target');
  } else if (!np || np.required !== false) {
    throw new Error('Unexpected or missing native prerequisite declaration');
  }
  return true;
}
export async function main(args = process.argv.slice(2)) {
  const o = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1] || Object.hasOwn(o, args[i].slice(2))) throw new Error('Invalid or duplicate arguments');
    o[args[i].slice(2)] = args[i + 1];
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo ?? '') || !/^\d+$/.test(o.run ?? '') || !/^[1-9]\d*$/.test(o.attempt ?? '') || !/^[a-f0-9]{40}$/i.test(o.sha ?? '') || !/^[a-f0-9]{40}$/i.test(o['workflow-sha'] ?? '') || !PROFILES.includes(o.profile) || !o.task || !path.isAbsolute(o.dir ?? '')) throw new Error('Missing or invalid verifier arguments');
  await mkdir(o.dir, { recursive: true });
  if ((await readdir(o.dir)).length) throw new Error('Destination must be empty');
  const run = gh(['api', `repos/${o.repo}/actions/runs/${o.run}`], true);
  if (run.path !== '.github/workflows/ts-gates.yml' || run.head_sha !== o['workflow-sha']) throw new Error('Workflow path or trusted workflow SHA mismatch');
  const jobsPages = gh(['api', '--paginate', '--slurp', `repos/${o.repo}/actions/runs/${o.run}/attempts/${o.attempt}/jobs?per_page=100`], true);
  const jobs = jobsPages.flatMap(p => p.jobs);
  const matches = jobs.filter(j => j.name === `TS / ${o.profile}`);
  if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') throw new Error('Matching attempt job did not complete successfully');
  const pages = gh(['api', '--paginate', '--slurp', `repos/${o.repo}/actions/runs/${o.run}/artifacts?per_page=100`], true);
  const name = `ts-gate-${o.run}-${o.attempt}-${o.profile}`;
  const artifacts = pages.flatMap(p => p.artifacts).filter(a => a.name === name && !a.expired);
  if (artifacts.length !== 1) throw new Error('Exact live artifact missing or ambiguous');
  gh(['run', 'download', o.run, '-R', o.repo, '-n', name, '-D', o.dir]);
  const receipt = JSON.parse(await readFile(path.join(o.dir, 'receipt.json'), 'utf8'));
  await validateReceipt(receipt, { sha: o.sha, workflowSha: o['workflow-sha'], profile: o.profile, task: o.task, run: o.run, attempt: o.attempt }, o.dir);
  const verification = { version: 1, status: 'success', verified_at: new Date().toISOString(), run_url: run.html_url, run_id: o.run, attempt: o.attempt, job_id: matches[0].id, artifact_id: artifacts[0].id, artifact_digest: artifacts[0].digest ?? null, artifact_digest_independently_verified: false, artifact_api_metadata: artifacts[0], job_api_metadata: matches[0], source_sha: o.sha, workflow_sha: o['workflow-sha'], profile: o.profile, task_id: o.task, receipt_sha256: hash(await readFile(path.join(o.dir, 'receipt.json'))) };
  await writeFile(path.join(o.dir, 'verification.json'), JSON.stringify(verification, null, 2) + '\n');
  return verification;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main())); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
