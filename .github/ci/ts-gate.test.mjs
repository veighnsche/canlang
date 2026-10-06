import test from 'node:test';
import assert from 'node:assert/strict';
import { runChild, successful, testCounts } from './ts-gate.mjs';
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
