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
test('verifier enforces native prerequisite on cloudflare, forbids surprise on ui', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'can-ci-verifier-native-'));
  try {
    const digest = s => createHash('sha256').update(s).digest('hex');
    const cmd = (n, argv, extra = {}) => ({ status: 'success', exit: 0, timedout: false, signal: null, error: null, argv, stdout_log: `${n}-stdout.log`, stderr_log: `${n}-stderr.log`, stdout_sha256: digest('ok'), stderr_sha256: digest(''), counts: { tests: null, pass: null, fail: null, skipped: null }, env: null, ...extra });
    for (const n of ['000', '001', '002', '003', '004']) {
      await writeFile(path.join(dir, `${n}-stdout.log`), 'ok');
      await writeFile(path.join(dir, `${n}-stderr.log`), '');
    }
    const bin = path.join(dir, 'bin');
    const np = { required: true, target_dir: dir, bin, lock_sha256: 'a'.repeat(64), toolchain_sha256: 'b'.repeat(64), bin_sha256: 'c'.repeat(64), ok: true };
    const expected = { sha: 'a'.repeat(40), workflowSha: 'b'.repeat(40), profile: 'cloudflare', task: 't', run: '1', attempt: '1' };
    const r = { version: 1, status: 'success', source_sha: expected.sha, expected_sha: expected.sha, workflow_sha: expected.workflowSha, profile: 'cloudflare', task_id: 't', run_id: '1', attempt: '1', native_prerequisite: np,
      commands: [cmd('000', ['rustup', 'toolchain', 'install', '1.99.0', '--profile', 'minimal']), cmd('001', ['rustc', '+1.99.0', '--version']), cmd('002', ['cargo', '+1.99.0', '--version']),
        cmd('003', ['cargo', '+1.99.0', 'build', '--locked', '--bin', 'can-preparation', '--manifest-path', '/repo/Cargo.toml'], { env: { CARGO_TARGET_DIR: dir } }),
        cmd('004', ['bunx', 'vitest', 'run', 'packages/cloudflare/test'], { env: { CAN_PREPARATION_BIN: bin }, counts: { tests: 2, pass: 2, fail: 0, skipped: 0 } })] };
    assert.equal(await validateReceipt(r, expected, dir), true);
    const missing = structuredClone(r); delete missing.native_prerequisite;
    await assert.rejects(validateReceipt(missing, expected, dir));
    const failedNp = structuredClone(r); failedNp.native_prerequisite.ok = false;
    await assert.rejects(validateReceipt(failedNp, expected, dir));
    const badHash = structuredClone(r); badHash.native_prerequisite.bin_sha256 = 'zz';
    await assert.rejects(validateReceipt(badHash, expected, dir));
    const dropped = structuredClone(r); dropped.commands.splice(3, 1);
    await assert.rejects(validateReceipt(dropped, expected, dir));
    const wrongEnv = structuredClone(r); wrongEnv.commands[4].env.CAN_PREPARATION_BIN = path.join(dir, 'other');
    await assert.rejects(validateReceipt(wrongEnv, expected, dir));
    const uiExpected = { ...expected, profile: 'ui' };
    const uiOk = structuredClone(r); uiOk.profile = 'ui'; uiOk.native_prerequisite = { required: false };
    assert.equal(await validateReceipt(uiOk, uiExpected, dir), true);
    const uiLegacy = structuredClone(r); uiLegacy.profile = 'ui'; delete uiLegacy.native_prerequisite;
    assert.equal(await validateReceipt(uiLegacy, uiExpected, dir), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
