import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const profiles = ['values','state','stdlib','identity','ui','interfaces','work','cloudflare','testkit','workspace'];
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
  if (receipt.version !== 1 || receipt.status !== 'success' || receipt.error || !Array.isArray(receipt.commands) || !receipt.commands.length) throw new Error('Receipt is not successful');
  const root = await realpath(dir);
  for (const c of receipt.commands) {
    if (c.status !== 'success' || c.exit !== 0 || c.signal || c.timedout || c.error || !Array.isArray(c.argv) || !c.argv.length) throw new Error('Receipt contains unsuccessful command');
    for (const stream of ['stdout','stderr']) {
      const name = c[`${stream}_log`];
      if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+\.log$/.test(name)) throw new Error('Unsafe log filename');
      const full = path.join(dir, name);
      if (path.dirname(await realpath(full)) !== root) throw new Error('Log escapes receipt directory');
      if (hash(await readFile(full)) !== c[`${stream}_sha256`]) throw new Error('Log checksum mismatch');
    }
    const isTest = c.argv.includes('test') || c.argv.includes('--test') || c.argv.includes('vitest');
    if (isTest && c.counts?.tests != null && (c.counts.tests === 0 || c.counts.tests === c.counts.skipped)) throw new Error('No executed tests');
  }
  return true;
}
export async function main(args = process.argv.slice(2)) {
  const o = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1] || Object.hasOwn(o, args[i].slice(2))) throw new Error('Invalid or duplicate arguments');
    o[args[i].slice(2)] = args[i + 1];
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo ?? '') || !/^\d+$/.test(o.run ?? '') || !/^[1-9]\d*$/.test(o.attempt ?? '') || !/^[a-f0-9]{40}$/i.test(o.sha ?? '') || !/^[a-f0-9]{40}$/i.test(o['workflow-sha'] ?? '') || !profiles.includes(o.profile) || !o.task || !path.isAbsolute(o.dir ?? '')) throw new Error('Missing or invalid verifier arguments');
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
