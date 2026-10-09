import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const installed = await realpath(fileURLToPath(new URL('../../../../', import.meta.url)));
const root = join(installed, 'test-results/can-dev-server/failures-root');
const sourcePath = join(root, 'tests/integration/can-dev-server/OfficeSupplies.can');
const native = join(root, 'compiler/target/debug/can');
const control = join(installed, 'packages/cloudflare/dist/dev/control-cli.js');
const catalog = join(installed, 'packages/values/dist/catalog.json');
const output = join(installed, 'test-results/can-dev-server/failures-result.json');
const runtime = join(await realpath(tmpdir()), `cv-${process.getuid()}`);
const descriptorPath = join(runtime, createHash('sha256').update(root).digest('hex').slice(0, 24), 'descriptor.json');

async function prepareRoot() {
  const hasDescriptor = await stat(descriptorPath).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  assert.equal(hasDescriptor, false, 'private failure root has an existing owner descriptor; refuse replacement');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const path of ['package.json', 'compiler/Cargo.toml', 'compiler/Cargo.lock',
    'compiler/src', 'compiler/target/debug/can', 'docs/specification/GRAMMAR.md',
    'docs/specification/CONSTRUCT-HELP.md', 'docs/specification/DESIGN.md',
    'design/UI-COMPONENTS.md', 'packages/ui/src/catalog.ts', 'packages/values/src/catalog.ts',
    'tests/integration/can-dev-server/OfficeSupplies.can']) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(installed, path), target, { recursive: true, preserveTimestamps: true });
  }
  await symlink(join(installed, 'node_modules'), join(root, 'node_modules'));
}

await prepareRoot();
const original = await readFile(sourcePath, 'utf8');
const originalSha = createHash('sha256').update(original).digest('hex');
const replacementFrom = 'other,"A4 paper",8 -> "A4 paper",8';
const replacementTo = 'other,"A4 paper",8 -> "Deliberately wrong",8';
assert.equal(original.split(replacementFrom).length, 2);
const result = { schema: 'can-dev-failures-local.v1',
  compilerSha256: createHash('sha256').update(await readFile(native)).digest('hex'),
  controlSha256: createHash('sha256').update(await readFile(control)).digest('hex'),
  catalogSha256: createHash('sha256').update(await readFile(catalog)).digest('hex'),
  sourceOriginalSha: originalSha, outcome: 'incomplete' };
let ownSession = null;
let edited = false;

async function run(command, flags = [], session = ownSession) {
  const args = ['dev', command, '--root', root,
    ...(session === null ? [] : ['--session', session, '--app', 'OfficeSupplies', '--profile', 'local-d1-identity']),
    ...flags];
  try {
    const { stdout } = await execute(native, args, { cwd: root,
      env: { ...process.env, CAN_DEV_BIN: control }, maxBuffer: 512 * 1024, timeout: 110_000 });
    return JSON.parse(stdout);
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim() !== '') return JSON.parse(error.stdout);
    throw error;
  }
}

function success(envelope, name) {
  assert.equal(envelope.ok, true, `${name}: ${envelope.code ?? 'unknown'} ${envelope.detail ?? ''}`);
  assert.equal(envelope.session, ownSession, `${name}: selected wrong owner`);
  return envelope.result;
}

function revision(status) {
  return status.revision ?? status.current?.revision ?? null;
}

async function changedRevision(previous) {
  const baseline = Number(previous?.slice(1));
  assert.ok(Number.isSafeInteger(baseline));
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const current = success(await run('status'), 'status').revision;
    if (typeof current === 'string' && Number(current.slice(1)) > baseline) return current;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('source revision did not advance after private edit');
}

try {
  const before = await run('discover', ['--app', 'OfficeSupplies', '--profile', 'local-d1-identity'], null);
  assert.equal(before.ok, false, 'private failure root already has a live owner; refuse attachment');
  const started = await run('start', ['--source', 'tests/integration/can-dev-server/OfficeSupplies.can',
    '--catalog', catalog,
    '--help-index', join(root, 'docs/specification/CONSTRUCT-HELP.md')], null);
  assert.equal(started.ok, true, `start: ${started.code ?? 'unknown'} ${started.detail ?? ''}`);
  assert.equal(started.result.attached, false);
  ownSession = started.session;
  assert.match(ownSession, /^[A-Za-z0-9_-]+$/);
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  assert.equal(descriptor.sessionId, ownSession);
  assert.equal(descriptor.root, root);
  result.sessionVerified = true;
  const initial = success(await run('status'), 'status');
  const initialRevision = revision(initial);
  assert.match(initialRevision, /^r[1-9][0-9]*$/);
  result.initial = { revision: initialRevision, lifecycle: initial.lifecycle ?? null };

  await writeFile(sourcePath, original.replace(replacementFrom, replacementTo));
  edited = true;
  const wrongRevision = await changedRevision(initialRevision);
  const settledWrong = success(await run('check'), 'settle wrong');
  assert.match(settledWrong.revision, /^r[1-9][0-9]*$/);
  const admittedWrongRevision = settledWrong.revision;
  const checked = success(await run('check', ['--expected-revision', admittedWrongRevision]), 'check wrong');
  result.wrong = { observedRevision: wrongRevision, revision: admittedWrongRevision, check: checked };
  const runResult = success(await run('example.run', ['--expected-revision', admittedWrongRevision]), 'example.run');
  assert.equal(runResult.ok, false);
  assert.equal(runResult.summary.failed, 1);
  assert.equal(runResult.summary.passed, 1);
  assert.equal(runResult.summary.setupFailed, 0);
  assert.equal(runResult.summary.unsupported, 0);
  assert.equal(runResult.focus?.origin, 'example');
  assert.equal(runResult.focus?.phase, 'assertion');
  assert.equal(runResult.focus?.summary, 'Example assertion failed.');
  const ref = runResult.focus.ref;
  result.run = { revision: runResult.revision, runId: runResult.run_id,
    artifactDigest: runResult.artifact_digest, summary: runResult.summary,
    failureRef: ref, phase: runResult.focus.phase, evidence: runResult.focus.evidence };

  const listed = success(await run('failures', ['--revision', admittedWrongRevision, '--limit', '25']), 'failures');
  assert.ok(listed.failures.some(item => item.ref === ref));
  const lookup = success(await run('failure.lookup', ['--ref', ref]), 'failure.lookup');
  assert.equal(lookup.ref, ref);
  const detail = success(await run('failure.detail', ['--ref', ref]), 'failure.detail');
  assert.equal(detail.ref, ref);
  assert.equal(detail.detail.outcome, 'failed');
  assert.ok(detail.detail.mismatch_count >= 1);
  result.failure = { totalRetained: listed.total_retained, listContainsRef: true,
    lookupPhase: lookup.phase, detailOutcome: detail.detail.outcome,
    mismatchCount: detail.detail.mismatch_count, sourceRevision: detail.source_revision };

  const rerun = success(await run('example.rerun', ['--ref', ref]), 'example.rerun');
  assert.equal(rerun.ok, true);
  assert.equal(rerun.kind, 'isolated_example_rerun');
  assert.equal(rerun.original.outcome, 'failed');
  assert.equal(rerun.rerun.outcome, 'failed');
  assert.notEqual(rerun.original.run_id, rerun.rerun.run_id);
  assert.equal(rerun.artifact.artifactDigest, runResult.artifact_digest);
  async function verifyRerunFailure(attempt, previousRefs) {
    const focus = attempt.focus;
    assert.equal(focus.origin, 'example');
    assert.equal(focus.revision, runResult.revision);
    assert.equal(focus.source_revision, runResult.source_revision);
    assert.equal(focus.serving_build, runResult.serving_build);
    assert.equal(focus.owner_ref.run_id, attempt.rerun.run_id);
    assert.ok(!previousRefs.includes(focus.ref));
    const found = success(await run('failure.lookup', ['--ref', focus.ref]), 'rerun failure.lookup');
    assert.deepEqual(found, focus);
    const saved = success(await run('failure.detail', ['--ref', focus.ref]), 'rerun failure.detail');
    assert.equal(saved.detail.outcome, 'failed');
    assert.equal(saved.detail.artifact_digest, runResult.artifact_digest);
    const page = success(await run('failures', ['--revision', runResult.revision, '--limit', '25']), 'rerun failures');
    for (const retainedRef of [...previousRefs, focus.ref]) assert.ok(page.failures.some(item => item.ref === retainedRef));
    assert.doesNotMatch(JSON.stringify({ attempt, found, saved }), /Deliberately wrong|"(?:expected|actual|caller|mismatches)"\s*:/);
    return focus.ref;
  }
  const rerunRef = await verifyRerunFailure(rerun, [ref]);
  result.rerunBeforeRestore = { kind: rerun.kind, originalRunId: rerun.original.run_id,
    rerunRunId: rerun.rerun.run_id, artifactDigest: rerun.artifact.artifactDigest,
    inputs: rerun.inputs, outcome: rerun.rerun.outcome, failureRef: rerunRef };

  await writeFile(sourcePath, original);
  edited = false;
  assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), originalSha);
  const restoredRevision = await changedRevision(admittedWrongRevision);
  const settledRestored = success(await run('check'), 'settle restored');
  assert.match(settledRestored.revision, /^r[1-9][0-9]*$/);
  const restored = success(await run('check', ['--expected-revision', settledRestored.revision]), 'check restored');
  result.restored = { observedRevision: restoredRevision, revision: settledRestored.revision, check: restored };
  const rerunAfter = success(await run('example.rerun', ['--ref', ref]), 'retained example.rerun');
  assert.equal(rerunAfter.ok, true);
  assert.equal(rerunAfter.original.run_id, runResult.run_id);
  assert.equal(rerunAfter.rerun.outcome, 'failed');
  assert.notEqual(rerunAfter.rerun.run_id, rerun.rerun.run_id);
  assert.equal(rerunAfter.artifact.artifactDigest, runResult.artifact_digest);
  const rerunAfterRef = await verifyRerunFailure(rerunAfter, [ref, rerunRef]);
  assert.deepEqual(success(await run('failure.lookup', ['--ref', ref]), 'original lookup after restore'), lookup);
  assert.equal(success(await run('failure.lookup', ['--ref', rerunRef]), 'earlier rerun lookup after restore').owner_ref.run_id,
    rerun.rerun.run_id);
  result.rerunAfterRestore = { originalRunId: rerunAfter.original.run_id,
    rerunRunId: rerunAfter.rerun.run_id, outcome: rerunAfter.rerun.outcome,
    artifactDigest: rerunAfter.artifact.artifactDigest, inputs: rerunAfter.inputs, failureRef: rerunAfterRef };
  result.outcome = 'passed';
} catch (error) {
  result.outcome = 'failed';
  result.failureCause = { name: error.name, message: String(error.message).slice(0, 400) };
} finally {
  if (edited) {
    await writeFile(sourcePath, original);
    result.sourceRestoredInFinally = true;
  }
  result.finalSourceSha = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
  if (ownSession !== null) {
    try {
      const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
      assert.equal(descriptor.sessionId, ownSession);
      assert.equal(descriptor.root, root);
      const stopped = success(await run('stop'), 'stop');
      result.stop = { ownSession: true, stopped: stopped.stopped === true };
      const absent = await stat(descriptorPath).then(() => false, error => error.code === 'ENOENT');
      result.stop.descriptorRemoved = absent;
      assert.equal(result.stop.stopped, true);
      assert.equal(absent, true, 'owned descriptor remains after stop');
    } catch (error) {
      result.stop = { ownSession: true, error: String(error.message).slice(0, 250) };
      result.outcome = 'failed';
    }
  }
  if (result.finalSourceSha !== originalSha) result.outcome = 'failed';
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ outcome: result.outcome, initial: result.initial?.revision,
    wrong: result.wrong?.revision, restored: result.restored?.revision,
    run: result.run?.summary, failure: result.failure?.lookupPhase,
    rerunBefore: result.rerunBeforeRestore?.outcome,
    rerunAfter: result.rerunAfterRestore?.outcome, stop: result.stop,
    failureCause: result.failureCause }));
  if (result.outcome !== 'passed') process.exitCode = 1;
}
