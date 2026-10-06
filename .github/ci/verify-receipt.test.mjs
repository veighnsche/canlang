import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateReceipt } from './verify-receipt.mjs';
test('independent verifier rejects failure, skip, mismatch and changed log', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'can-ci-verifier-'));
  try {
    await writeFile(path.join(dir, 'stdout.log'), 'ok');
    await writeFile(path.join(dir, 'stderr.log'), '');
    const digest = s => createHash('sha256').update(s).digest('hex');
    const expected = { sha: 'a'.repeat(40), workflowSha: 'b'.repeat(40), profile: 'ui', task: 't', run: '1', attempt: '2' };
    const r = { version: 1, status: 'success', source_sha: expected.sha, expected_sha: expected.sha, workflow_sha: expected.workflowSha, profile: 'ui', task_id: 't', run_id: '1', attempt: '2', commands: [{ status: 'success', exit: 0, timedout: false, signal: null, argv: ['node', '--test'], stdout_log: 'stdout.log', stderr_log: 'stderr.log', stdout_sha256: digest('ok'), stderr_sha256: digest(''), counts: { tests: 1, skipped: 0 } }] };
    assert.equal(await validateReceipt(r, expected, dir), true);
    for (const status of ['failed', 'skipped']) {
      const bad = structuredClone(r); bad.commands[0].status = status;
      await assert.rejects(validateReceipt(bad, expected, dir));
    }
    await assert.rejects(validateReceipt(r, { ...expected, sha: 'c'.repeat(40) }, dir));
    const allSkipped = structuredClone(r); allSkipped.commands[0].counts.skipped = 1;
    await assert.rejects(validateReceipt(allSkipped, expected, dir));
    const escape = structuredClone(r); escape.commands[0].stdout_log = '../stdout.log';
    await assert.rejects(validateReceipt(escape, expected, dir));
    await writeFile(path.join(dir, 'stdout.log'), 'changed');
    await assert.rejects(validateReceipt(r, expected, dir));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
