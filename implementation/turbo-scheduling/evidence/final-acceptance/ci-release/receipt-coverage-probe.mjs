import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateReceipt } from '../../../../../.github/ci/verify-receipt.mjs';
const dir = await mkdtemp(path.join(tmpdir(), 'can-receipt-coverage-review-'));
try {
  const digest = text => createHash('sha256').update(text).digest('hex');
  await writeFile(path.join(dir, 'stdout.log'), 'arbitrary command');
  await writeFile(path.join(dir, 'stderr.log'), '');
  const expected = { sha: 'a'.repeat(40), workflowSha: 'b'.repeat(40), profile: 'ui', task: 'review-probe', run: '1', attempt: '1' };
  const receipt = { version: 1, status: 'success', source_sha: expected.sha, expected_sha: expected.sha, workflow_sha: expected.workflowSha, profile: expected.profile, task_id: expected.task, run_id: expected.run, attempt: expected.attempt, commands: [{ argv: ['node', '-e', 'console.log("arbitrary command")'], status: 'success', exit: 0, timedout: false, signal: null, stdout_log: 'stdout.log', stderr_log: 'stderr.log', stdout_sha256: digest('arbitrary command'), stderr_sha256: digest('') }] };
  try {
    await validateReceipt(receipt, expected, dir);
    console.log(JSON.stringify({ acceptedIncompleteReceipt: true, omitted: ['git revision', 'node/bun versions', 'frozen install', 'producer build', 'typecheck', 'package test', 'git diff'] }, null, 2));
  } catch (error) { console.log(JSON.stringify({ acceptedIncompleteReceipt: false, reason: error.message }, null, 2)); }
} finally { await rm(dir, { recursive: true, force: true }); }
