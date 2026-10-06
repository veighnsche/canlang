import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { gatePlan, executedTests, validToolVersion } from './gate-plan.mjs';
import { runChild, successful, testCounts, NATIVE_PROFILES, NATIVE_TOOLCHAIN, nativeTargetDir, nativeBinPath, nativePrerequisiteArgv, shouldSkipGate, buildPrerequisiteArgv, main } from './ts-gate.mjs';
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

test('package gates build the selected owner before tests and retain joined workspace coverage', () => {
  for (const profile of ['values', 'state', 'stdlib', 'identity', 'ui', 'interfaces', 'work']) {
    assert.deepEqual(buildPrerequisiteArgv(profile), ['bun', 'run', 'build', `--filter=@canlang/${profile}`]);
  }
  for (const profile of ['cloudflare', 'testkit', 'workspace']) {
    assert.deepEqual(buildPrerequisiteArgv(profile), ['bun', 'run', 'build']);
  }
  assert.throws(() => buildPrerequisiteArgv('--filter=other'), /Invalid gate profile/);
});


test('command plan labels only real tests and fixes producer/gate CWD', () => {
  const ui = gatePlan('ui', '/repo');
  assert.deepEqual(ui.filter(c => c.isTest).map(c => c.id), ['tests']);
  assert.equal(ui.find(c => c.id === 'build').cwd, '/repo');
  assert.equal(ui.find(c => c.id === 'tests').cwd, '/repo/packages/ui');
  const workspace = gatePlan('workspace', '/repo', { runnerTemp: '/private-temp' });
  assert.deepEqual(workspace.filter(c => c.isTest).map(c => c.id), ['boundary-tests', 'tests']);
  assert.ok(workspace.filter(c => c.isTest).every(c => c.env.CAN_PREPARATION_BIN === nativeBinPath('/private-temp/ts-gate-native/workspace')));
});

test('tool pins and executed test counts require positive evidence', () => {
  assert.equal(validToolVersion('node', 'v24.21.0'), true);
  assert.equal(validToolVersion('node', 'v22.21.0'), false);
  assert.equal(validToolVersion('bun', '1.4.2'), true);
  assert.equal(validToolVersion('bun', '1.4.3'), false);
  assert.equal(validToolVersion('rustc', 'rustc 1.99.0 (abcdef 2026-09-24)'), true);
  assert.equal(validToolVersion('cargo', 'cargo 1.100.0 (different pin)'), false);
  assert.equal(executedTests(testCounts('build complete')), false);
  assert.equal(executedTests(testCounts(' Tests  2 skipped (2)')), false);
  assert.equal(executedTests(testCounts(' Tests  1 passed | 1 skipped (2)')), true);
});

async function runnerFixture(profile, body) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'can-ci-runner-test-'));
  try {
    const cwd = path.join(scratch, 'candidate');
    const dir = path.join(scratch, 'receipt');
    await mkdir(path.join(cwd, 'packages', profile), { recursive: true });
    await writeFile(path.join(cwd, 'bun.lock'), 'fixture frozen lock');
    const sha = 'a'.repeat(40);
    const env = { CI_GATE_PROFILE: profile, CI_EXPECTED_SHA: sha, CI_TASK_ID: 'test', CI_RECEIPT_DIR: dir, RUNNER_TEMP: path.join(scratch, 'native-temp') };
    const calls = [];
    const run = failure => async (argv, options) => {
      calls.push({ argv, ...options });
      let stdout = 'command complete\n';
      if (argv[0] === 'git' && argv[1] === 'rev-parse') stdout = sha + '\n';
      else if (argv[0] === 'git') stdout = '';
      else if (argv[0] === 'node' && argv[1] === '--version') stdout = 'v24.21.0\n';
      else if (argv[0] === 'bun' && argv[1] === '--version') stdout = '1.4.2\n';
      else if (argv[0] === 'rustc') stdout = 'rustc 1.99.0 (abcdef 2026-09-24)\n';
      else if (argv[0] === 'cargo' && argv.includes('--version')) stdout = 'cargo 1.99.0 (abcdef 2026-09-24)\n';
      else if (argv.includes('test') || argv.includes('vitest') || argv.includes('--test')) stdout = 'ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ skipped 0\n';
      const failed = failure?.(argv) ?? false;
      return { argv, cwd: options.cwd, env: options.env, start: 'start', end: 'end', exit: failed ? 1 : 0, status: failed ? 'failed' : 'success', signal: null, timedout: false, error: null, stdout, stderr: '' };
    };
    await body({ env, cwd, dir, calls, run });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

test('runner executes independent tests after a typecheck failure and preserves the whole plan', async () => {
  await runnerFixture('ui', async ({ env, cwd, calls, run }) => {
    const receipt = await main(env, cwd, { run: run(argv => argv.includes('typecheck')) });
    assert.equal(receipt.status, 'failed');
    assert.deepEqual(receipt.commands.map(c => c.id), gatePlan('ui', cwd).map(c => c.id));
    assert.equal(receipt.commands.find(c => c.id === 'typecheck').status, 'failed');
    assert.equal(receipt.commands.find(c => c.id === 'tests').status, 'success');
    assert.equal(receipt.commands.at(-1).id, 'clean-tree');
    assert.ok(calls.some(c => c.argv.includes('test')));
  });
});

test('failed frozen install records skipped producer and dependent gates, then final tree check', async () => {
  await runnerFixture('ui', async ({ env, cwd, calls, run }) => {
    const receipt = await main(env, cwd, { run: run(argv => argv.includes('install')) });
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.commands.find(c => c.id === 'install').status, 'failed');
    for (const id of ['build', 'typecheck', 'tests']) assert.equal(receipt.commands.find(c => c.id === id).status, 'skipped');
    assert.equal(receipt.commands.at(-1).status, 'success');
    assert.ok(!calls.some(c => c.argv.includes('build') || c.argv.includes('test')));
  });
});

test('native failure records explicit prerequisites, skips tests, and still typechecks', async () => {
  await runnerFixture('cloudflare', async ({ env, cwd, run }) => {
    const receipt = await main(env, cwd, { run: run(argv => argv[0] === 'cargo' && argv.includes('build')) });
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.native_prerequisite.ok, false);
    assert.deepEqual(receipt.commands.filter(c => c.id.startsWith('native-') || ['rustc-version', 'cargo-version'].includes(c.id)).map(c => c.id),
      ['native-install', 'rustc-version', 'cargo-version', 'native-build']);
    assert.equal(receipt.commands.find(c => c.id === 'typecheck').status, 'success');
    for (const id of ['tests', 'runtime-tests']) assert.equal(receipt.commands.find(c => c.id === id).status, 'skipped');
  });
});

test('runner fails closed on absent, zero, or all-skipped test summaries despite exit zero', async () => {
  for (const summary of ['command complete\n', ' Tests  0 passed (0)\n', ' Tests  2 skipped (2)\n']) {
    await runnerFixture('ui', async ({ env, cwd, run }) => {
      const base = run();
      const receipt = await main(env, cwd, { run: async (argv, options) => {
        const result = await base(argv, options);
        if (argv.includes('test')) result.stdout = summary;
        return result;
      } });
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.commands.find(c => c.id === 'tests').status, 'failed');
      assert.equal(receipt.commands.at(-1).status, 'success');
    });
  }
});
