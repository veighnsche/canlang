import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runChild, successful, testCounts, NATIVE_PROFILES, NATIVE_TOOLCHAIN, nativeTargetDir, nativeBinPath, nativePrerequisiteArgv, shouldSkipGate } from './ts-gate.mjs';
test('nonzero child remains failed even with passing-looking output', async () => {
  const result = await runChild([process.execPath, '-e', "console.log('# pass 99'); process.exit(7)"]);
  assert.equal(result.exit, 7);
  assert.equal(successful([result]), false);
});
test('timed out process is failed', async () => {
  const result = await runChild([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 });
  assert.equal(result.timedout, true);
  assert.equal(successful([result]), false);
});
test('skips and empty execution cannot produce success', () => {
  assert.equal(successful([]), false);
  assert.equal(successful([{ status: 'success' }, { status: 'skipped' }]), false);
});
test('node test count formats and absent counts', () => {
  assert.deepEqual(testCounts('ℹ tests 2\nℹ pass 1\nℹ fail 0\nℹ skipped 1'), { tests: 2, pass: 1, fail: 0, skipped: 1 });
  assert.deepEqual(testCounts('build complete'), { tests: null, pass: null, fail: null, skipped: null });
});

test('Vitest ANSI summaries expose all-skipped and mixed test counts', () => {
  assert.deepEqual(testCounts('\x1b[32m Tests  3 skipped (3)\x1b[0m'), { tests: 3, pass: 0, fail: 0, skipped: 3 });
  assert.deepEqual(testCounts(' Tests  2 failed | 7 passed | 1 skipped (10)'), { tests: 10, pass: 7, fail: 2, skipped: 1 });
  assert.deepEqual(testCounts(' Tests  4 passed (4)'), { tests: 4, pass: 4, fail: 0, skipped: 0 });
});
test('native prerequisite required only for cloudflare and workspace', () => {
  assert.deepEqual([...NATIVE_PROFILES].sort(), ['cloudflare', 'workspace']);
  assert.equal(NATIVE_TOOLCHAIN, '1.99.0');
});
test('native prerequisite argv is fixed, locked, and checkout-absolute', () => {
  const argv = nativePrerequisiteArgv('/repo');
  assert.equal(argv.length, 4);
  assert.deepEqual(argv[0], ['rustup', 'toolchain', 'install', '1.99.0', '--profile', 'minimal']);
  assert.deepEqual(argv[1], ['rustc', '+1.99.0', '--version']);
  assert.deepEqual(argv[2], ['cargo', '+1.99.0', '--version']);
  assert.deepEqual(argv[3], ['cargo', '+1.99.0', 'build', '--locked', '--bin', 'can-preparation', '--manifest-path', path.join('/repo', 'packages', 'cloudflare', 'preparation', 'Cargo.toml')]);
  assert.ok(path.isAbsolute(argv[3].at(-1)));
  assert.ok(!argv.flat().some(a => a.includes('build-preparation.mjs')));
});
test('native target and binary paths are private per profile', () => {
  const target = nativeTargetDir('/tmp/runner', 'cloudflare');
  assert.equal(target, path.join('/tmp/runner', 'ts-gate-native', 'cloudflare'));
  assert.ok(path.isAbsolute(target));
  const bin = nativeBinPath(target);
  assert.equal(path.dirname(bin), path.join(target, 'debug'));
  assert.ok(path.basename(bin).startsWith('can-preparation'));
});
test('env overrides reach the child process only', async () => {
  delete process.env.CAN_PREPARATION_BIN;
  const result = await runChild([process.execPath, '-e', 'console.log(process.env.CAN_PREPARATION_BIN ?? "absent")'], { env: { CAN_PREPARATION_BIN: '/private/bin' } });
  assert.equal(result.status, 'success');
  assert.match(result.stdout, /\/private\/bin/);
  assert.equal(process.env.CAN_PREPARATION_BIN, undefined);
  assert.deepEqual(result.env, { CAN_PREPARATION_BIN: '/private/bin' });
});
test('skip matrix fails closed on unready native prerequisite for tests only', () => {
  assert.equal(shouldSkipGate({ ready: true, nativeReady: true, isTest: true }), false);
  assert.equal(shouldSkipGate({ ready: true, nativeReady: true, isTest: false }), false);
  assert.equal(shouldSkipGate({ ready: true, nativeReady: false, isTest: true }), true);
  assert.equal(shouldSkipGate({ ready: true, nativeReady: false, isTest: false }), false);
  assert.equal(shouldSkipGate({ ready: false, nativeReady: true, isTest: false }), true);
});
