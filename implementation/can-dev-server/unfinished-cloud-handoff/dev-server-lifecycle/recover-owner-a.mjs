import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = await realpath('/workspace/.canlang-env/dev-server-life-a');
const rootB = await realpath('/workspace/.canlang-env/dev-server-life-b');
const native = join(root, 'compiler/target/debug/can');
const output = '/workspace/.canlang-env/logs/dev-server-lifecycle/recovery.json';
const control = '/workspace/canlang/packages/cloudflare/dist/dev/control-cli.js';
const facts = JSON.parse(await readFile('/workspace/.canlang-env/logs/dev-server-lifecycle/facts.json', 'utf8'));
const original = facts.cleanup.crashedA;
const runtime = join(await realpath(tmpdir()), `cv-${process.getuid()}`);
const directory = selected => join(runtime, createHash('sha256').update(selected).digest('hex').slice(0, 24));
const descriptorPath = join(directory(root), 'descriptor.json');
const claimPath = join(directory(root), 'claim.json');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => stat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const proc = async pid => {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8');
  assert.ok(text.startsWith(`${pid} (`));
  const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
  return { state: fields[0], birth: `proc:${(await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()}:${fields[19]}` };
};
const run = async (command, selectedRoot, flags = []) => {
  const args = ['dev', command, '--root', selectedRoot, ...flags];
  try {
    const { stdout } = await execute(native, args, { cwd: selectedRoot,
      env: { ...process.env, CAN_DEV_BIN: control }, maxBuffer: 256 * 1024, timeout: 90_000 });
    return JSON.parse(stdout);
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim() !== '') return JSON.parse(error.stdout);
    throw error;
  }
};

const result = { producerCommit: 'd478ee36', nativeProducerCommit: '890ed600', recovery: 'incomplete' };
let created;
try {
  const oldClaim = await json(claimPath);
  const oldDescriptor = await json(descriptorPath);
  assert.equal(oldClaim.root, root);
  assert.equal(oldClaim.sessionId, original.session);
  assert.equal(oldClaim.pid, original.verifiedPid);
  assert.equal(oldDescriptor.sessionId, original.session);
  assert.equal(oldDescriptor.pid, original.verifiedPid);
  const previousProcess = await proc(oldClaim.pid);
  assert.equal(previousProcess.state, 'Z');
  assert.equal(previousProcess.birth, oldClaim.processBirth);
  result.previousOwner = { session: oldClaim.sessionId, pid: oldClaim.pid, state: previousProcess.state,
    recordedBirthVerified: true };

  const started = await run('start', root, ['--source', 'tests/integration/can-dev-server/OfficeSupplies.can',
    '--catalog', '/workspace/canlang/packages/values/dist/catalog.json',
    '--help-index', join(root, 'docs/specification/CONSTRUCT-HELP.md')]);
  result.start = { ok: started.ok, ...(started.ok ? { attached: started.result.attached } : { code: started.code, detail: started.detail }) };
  if (started.ok) {
    created = started.session;
    assert.notEqual(created, oldClaim.sessionId);
    assert.equal(started.result.attached, false);
    const descriptor = await json(descriptorPath);
    const claim = await json(claimPath);
    assert.equal(descriptor.root, root);
    assert.equal(descriptor.app, 'OfficeSupplies');
    assert.equal(descriptor.profile, 'local-d1-identity');
    assert.equal(descriptor.sessionId, created);
    assert.equal(claim.sessionId, created);
    assert.equal(claim.pid, descriptor.pid);
    assert.notEqual(descriptor.pid, oldClaim.pid);
    const processInfo = await proc(descriptor.pid);
    assert.ok(!['Z', 'X'].includes(processInfo.state));
    assert.equal(processInfo.birth, claim.processBirth);
    assert.notEqual(claim.processBirth, oldClaim.processBirth);
    result.newOwner = { session: created, pid: descriptor.pid, recordedBirthVerified: true, differentBirth: true };
    const flags = ['--session', created, '--app', 'OfficeSupplies', '--profile', 'local-d1-identity'];
    const discovered = await run('discover', root, flags);
    assert.equal(discovered.ok, true);
    assert.equal(discovered.session, created);
    const status = await run('status', root, flags);
    assert.equal(status.ok, true);
    assert.equal(status.session, created);
    result.discover = 'verified new session';
    result.status = { ok: true, lifecycle: status.result.lifecycle ?? null,
      revision: status.result.revision ?? status.result.current?.revision ?? null };
    result.recovery = 'passed';
  }
} catch (error) {
  result.recovery = 'failed';
  result.failure = { name: error.name, message: String(error.message).slice(0, 250) };
} finally {
  if (created) {
    try {
      const descriptor = await json(descriptorPath);
      assert.equal(descriptor.sessionId, created);
      assert.equal(descriptor.root, root);
      assert.notEqual(descriptor.pid, original.verifiedPid);
      const stopped = await run('stop', root, ['--session', created, '--app', 'OfficeSupplies', '--profile', 'local-d1-identity']);
      result.stop = { ok: stopped.ok, ...(stopped.ok ? { stopped: stopped.result.stopped } : { code: stopped.code }) };
      assert.equal(stopped.ok, true);
      assert.equal(stopped.session, created);
      assert.equal(await exists(descriptorPath), false);
      result.descriptorRemoved = true;
    } catch (error) {
      result.cleanupFailure = { name: error.name, message: String(error.message).slice(0, 250) };
      result.recovery = 'failed';
    }
  }
  try {
    const b = await run('discover', rootB, ['--app', 'OfficeSupplies', '--profile', 'local-d1-identity']);
    result.bStopped = { discoverOk: b.ok, ...(b.ok ? {} : { code: b.code }), descriptorAbsent: !await exists(join(directory(rootB), 'descriptor.json')) };
    assert.equal(b.ok, false);
    assert.equal(result.bStopped.descriptorAbsent, true);
  } catch (error) {
    result.bVerificationFailure = { name: error.name, message: String(error.message).slice(0, 250) };
    result.recovery = 'failed';
  }
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result));
}
