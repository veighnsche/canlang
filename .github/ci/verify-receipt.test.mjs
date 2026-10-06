import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateReceipt } from './verify-receipt.mjs';
import { PROFILES, PLAN_VERSION, NATIVE_PROFILES, nativeTargetDir, nativeBinPath, gatePlan, testCounts } from './gate-plan.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
async function fixture(profile, body, { runnerTemp = '/home/runner/work/_temp' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'can-ci-verifier-'));
  try {
    const expected = { sha: 'a'.repeat(40), workflowSha: 'b'.repeat(40), profile, task: 'gate-review', run: '1', attempt: '2' };
    const source = '/home/runner/work/canlang/candidate';
    const plan = gatePlan(profile, source, { runnerTemp, platform: 'linux' });
    const receipt = { version: 1, plan_version: PLAN_VERSION, status: 'success', source_dir: source, runner_temp: runnerTemp,
      platform: { os: 'linux', arch: 'x64' }, source_sha: expected.sha, expected_sha: expected.sha, workflow_sha: expected.workflowSha,
      profile, task_id: expected.task, run_id: expected.run, attempt: expected.attempt, lock_sha256: 'c'.repeat(64),
      toolversions: { node: 'v24.21.0', bun: '1.4.2' }, native_prerequisite: { required: false }, commands: [] };
    if (NATIVE_PROFILES.includes(profile)) {
      const target = nativeTargetDir(runnerTemp, profile);
      receipt.native_prerequisite = { required: true, ok: true, target_dir: target, bin: nativeBinPath(target, 'linux'),
        lock_sha256: 'd'.repeat(64), toolchain_sha256: 'e'.repeat(64), bin_sha256: 'f'.repeat(64) };
      receipt.toolversions.rustc = 'rustc 1.99.0 (abcdef 2026-09-24)';
      receipt.toolversions.cargo = 'cargo 1.99.0 (abcdef 2026-09-24)';
    }
    async function setLog(command, stdout, stderr = '') {
      await writeFile(path.join(dir, command.stdout_log), stdout);
      await writeFile(path.join(dir, command.stderr_log), stderr);
      command.stdout_sha256 = digest(stdout); command.stderr_sha256 = digest(stderr);
      command.counts = testCounts(stdout + '\n' + stderr);
    }
    for (const [index, step] of plan.entries()) {
      const c = { id: step.id, argv: step.argv, cwd: step.cwd, env: step.env, isTest: step.isTest, status: 'success', exit: 0,
        signal: null, error: null, timedout: false, stdout_log: `${index}-stdout.log`, stderr_log: `${index}-stderr.log` };
      let output = `${step.id} complete\n`;
      if (step.id === 'revision') output = expected.sha + '\n';
      else if (step.id.endsWith('-version')) output = receipt.toolversions[step.id.replace('-version', '')] + '\n';
      else if (step.id === 'clean-tree') output = '';
      else if (step.isTest) output = step.argv.includes('vitest') ? ' Tests  2 passed (2)\n' : 'ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ skipped 0\n';
      await setLog(c, output);
      receipt.commands.push(c);
    }
    await body({ dir, receipt, expected, plan, setLog });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

for (const profile of PROFILES) {
  test(`${profile}: complete receipt passes; every omitted command and reordered gates reject`, async () => {
    await fixture(profile, async ({ receipt, expected, dir }) => {
      assert.equal(await validateReceipt(receipt, expected, dir), true);
      for (let index = 0; index < receipt.commands.length; index++) {
        const missing = structuredClone(receipt); missing.commands.splice(index, 1);
        await assert.rejects(validateReceipt(missing, expected, dir), /coverage mismatch/);
      }
      const reordered = structuredClone(receipt);
      const typecheck = reordered.commands.findIndex(c => c.id === 'typecheck');
      [reordered.commands[typecheck], reordered.commands[typecheck + 1]] = [reordered.commands[typecheck + 1], reordered.commands[typecheck]];
      await assert.rejects(validateReceipt(reordered, expected, dir), /plan mismatch/);
      const appended = structuredClone(receipt); appended.commands.push(structuredClone(appended.commands[0]));
      await assert.rejects(validateReceipt(appended, expected, dir), /coverage mismatch/);
    });
  });
}

test('failure, skip, identity, argv, CWD, test identity and malformed lock fail closed', async () => {
  await fixture('ui', async ({ receipt, expected, dir }) => {
    for (const status of ['failed', 'skipped']) {
      const bad = structuredClone(receipt); bad.commands[0].status = status;
      await assert.rejects(validateReceipt(bad, expected, dir), /unsuccessful command/);
    }
    for (const key of ['sha', 'workflowSha', 'profile', 'task', 'run', 'attempt']) {
      await assert.rejects(validateReceipt(receipt, { ...expected, [key]: 'wrong' }, dir), /mismatch/);
    }
    for (const mutate of [
      r => { r.commands.find(c => c.id === 'install').argv = ['bun', 'install']; },
      r => { r.commands.find(c => c.id === 'typecheck').cwd = r.source_dir; },
      r => { r.commands.find(c => c.id === 'tests').isTest = false; },
      r => { r.commands.find(c => c.id === 'tests').env = { NODE_OPTIONS: '--skip-tests' }; },
    ]) {
      const bad = structuredClone(receipt); mutate(bad);
      await assert.rejects(validateReceipt(bad, expected, dir), /plan mismatch/);
    }
    const badLock = structuredClone(receipt); badLock.lock_sha256 = 'not-a-hash';
    await assert.rejects(validateReceipt(badLock, expected, dir), /lock checksum/);
    const oldPlan = structuredClone(receipt); delete oldPlan.plan_version;
    await assert.rejects(validateReceipt(oldPlan, expected, dir), /unsupported command plan/);
  });
});

test('test counts are recomputed from authenticated logs and require passing execution', async () => {
  await fixture('ui', async ({ receipt, expected, dir, setLog }) => {
    const c = receipt.commands.find(c => c.id === 'tests');
    const bad = structuredClone(receipt); bad.commands.find(c => c.id === 'tests').counts.pass = 999;
    await assert.rejects(validateReceipt(bad, expected, dir), /counts disagree/);
    for (const log of ['command exited zero\n', 'ℹ tests 0\nℹ pass 0\nℹ fail 0\nℹ skipped 0\n',
      'ℹ tests 2\nℹ pass 0\nℹ fail 0\nℹ skipped 2\n', 'ℹ tests 2\nℹ pass 1\nℹ fail 1\nℹ skipped 0\n']) {
      await setLog(c, log);
      await assert.rejects(validateReceipt(receipt, expected, dir), /No passing executed tests/);
    }
  });
  await fixture('testkit', async ({ receipt, expected, dir, setLog }) => {
    await setLog(receipt.commands.find(c => c.id === 'tests'), '\x1b[32m Tests  2 skipped (2)\x1b[0m\n');
    await assert.rejects(validateReceipt(receipt, expected, dir), /No passing executed tests/);
  });
});

test('version and source proofs are checked against logs, not receipt labels', async () => {
  await fixture('ui', async ({ receipt, expected, dir, setLog }) => {
    const mismatched = structuredClone(receipt); mismatched.toolversions.node = 'v24.0.0';
    await assert.rejects(validateReceipt(mismatched, expected, dir), /node version proof/);
    for (const [id, output, pattern] of [['node-version', 'v22.0.0\n', /node version proof/], ['bun-version', '1.4.1\n', /bun version proof/],
      ['revision', 'c'.repeat(40) + '\n', /Revision log/], ['clean-tree', 'diff --git a/source b/source\n', /tree check/]]) {
      const c = receipt.commands.find(c => c.id === id);
      const original = id === 'revision' ? expected.sha + '\n' : id === 'clean-tree' ? '' : receipt.toolversions[id.replace('-version', '')] + '\n';
      await setLog(c, output);
      await assert.rejects(validateReceipt(receipt, expected, dir), pattern);
      await setLog(c, original);
    }
  });
});

test('checksums, unsafe names, reused logs, and escaping symlinks reject', async () => {
  await fixture('ui', async ({ receipt, expected, dir }) => {
    const c = receipt.commands[0];
    const changed = structuredClone(receipt); changed.commands[0].stdout_sha256 = '0'.repeat(64);
    await assert.rejects(validateReceipt(changed, expected, dir), /checksum mismatch/);
    const escape = structuredClone(receipt); escape.commands[0].stdout_log = '../stdout.log';
    await assert.rejects(validateReceipt(escape, expected, dir), /Unsafe/);
    const reused = structuredClone(receipt); reused.commands[1].stdout_log = c.stdout_log;
    await assert.rejects(validateReceipt(reused, expected, dir), /reused/);
    const external = dir + '-external.log';
    try {
      await writeFile(external, expected.sha + '\n');
      await symlink(external, path.join(dir, 'escape.log'));
      const linked = structuredClone(receipt); linked.commands[0].stdout_log = 'escape.log';
      await assert.rejects(validateReceipt(linked, expected, dir), /escapes/);
    } finally { await rm(external, { force: true }); }
  });
});

test('native profiles require exact private target, binary environment, hashes and pinned version logs', async () => {
  await fixture('cloudflare', async ({ receipt, expected, dir, setLog }) => {
    for (const mutate of [
      r => { delete r.native_prerequisite; },
      r => { r.native_prerequisite.ok = false; },
      r => { r.native_prerequisite.bin_sha256 = 'zz'; },
      r => { r.native_prerequisite.bin += '-other'; },
      r => { r.native_prerequisite.target_dir += '-other'; },
    ]) {
      const bad = structuredClone(receipt); mutate(bad);
      await assert.rejects(validateReceipt(bad, expected, dir), /native|Native/);
    }
    for (const id of ['native-build', 'tests', 'runtime-tests']) {
      const bad = structuredClone(receipt); bad.commands.find(c => c.id === id).env = null;
      await assert.rejects(validateReceipt(bad, expected, dir), /plan mismatch/);
    }
    for (const tool of ['rustc', 'cargo']) {
      const c = receipt.commands.find(c => c.id === `${tool}-version`);
      const original = receipt.toolversions[tool] + '\n';
      await setLog(c, `${tool} 1.100.0 (different pin)\n`);
      await assert.rejects(validateReceipt(receipt, expected, dir), /version proof/);
      await setLog(c, original);
    }
  });
  await fixture('workspace', async ({ receipt, expected, dir }) => {
    const bad = structuredClone(receipt); bad.commands.find(c => c.id === 'boundary-tests').env = null;
    await assert.rejects(validateReceipt(bad, expected, dir), /plan mismatch/);
  });
  await fixture('cloudflare', async ({ receipt, expected, dir }) => {
    await assert.rejects(validateReceipt(receipt, expected, dir), /private target/);
  }, { runnerTemp: '/home/runner/work/canlang/candidate/private-temp' });
  await fixture('ui', async ({ receipt, expected, dir }) => {
    receipt.native_prerequisite = { required: true, ok: true };
    await assert.rejects(validateReceipt(receipt, expected, dir), /Unexpected/);
  });
});
