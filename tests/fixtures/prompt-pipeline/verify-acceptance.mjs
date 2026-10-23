#!/usr/bin/env node
/** Real candidate checks with deterministic MCP submissions; no model invocation. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixture = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(fixture, '../../..');
const compiler = process.env.CAN_COMPILER_BIN ?? join(workspace, 'compiler/target/debug/can');
const cases = [['broken-keyword', 'test'], ['broken-view', 'playwright'], ['working-app', null]];
const selected = process.argv.slice(2);
const optInCases = ['request-replay'];
if (selected.some(name => !cases.some(([candidate]) => candidate === name) && !optInCases.includes(name))) {
  throw new Error(`Expected case names: ${[...cases.map(([name]) => name), ...optInCases].join(', ')}`);
}
const { dispatchControl, runFor, savedPathFor, attemptFor } = await import(pathToFileURL(join(workspace, 'packages/cloudflare/dist/generation/controls.js')).href);
const { executeJob, resumeSession, resetAttempt, readAttempt, readFence } = await import(pathToFileURL(join(workspace, 'packages/cloudflare/dist/generation/lifecycle.js')).href);
const { EXIT_UNKNOWN, EXIT_CONFLICT } = await import(pathToFileURL(join(workspace, 'packages/cloudflare/dist/generation/protocol.js')).href);
const exec = promisify(execFile);
const controlBin = process.env.CAN_DEV_BIN ?? 'can';
const controlPrefix = process.env.CAN_DEV_BIN === undefined ? ['dev'] : [];
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Acceptance verification requires Node 22 or newer');

async function assertNoDevSession() {
  let code = 0, stdout;
  try {
    ({ stdout } = await exec(controlBin, [...controlPrefix, 'discover', '--root', workspace,
      '--app', 'PromptStudio', '--profile', 'local-d1-identity'],
    { cwd: workspace, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024 }));
  } catch (error) {
    if (typeof error.code !== 'number' || error.killed) {
      throw new Error('Could not verify absence of the PromptStudio dev session; clone cleanup is held');
    }
    code = error.code;
    stdout = error.stdout;
  }
  let body;
  try { body = JSON.parse(stdout); }
  catch { throw new Error('Could not verify absence of the PromptStudio dev session; clone cleanup is held'); }
  if (body?.command === 'discover' && code === 1 && body.ok === false && body.code === 'CONTROL_IO' &&
      body.detail === 'No such file or directory (os error 2)') return;
  if (body?.command === 'discover' && code === 0 && body.ok === true) {
    throw new Error('A PromptStudio dev session is active; release its owner before this integration run');
  }
  throw new Error('Could not verify absence of the PromptStudio dev session; clone cleanup is held');
}

async function currentBytes(root) {
  const files = [];
  const base = join(root, 'can.generated');
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        assert.ok(entry.isFile(), 'Current groups must contain regular files');
        files.push([relative(base, path), (await readFile(path)).toString('hex')]);
      }
    }
  }
  await walk(base);
  return files;
}

// The executable only waits for host submissions and reports completion. It
// neither calls a model nor reads the app or edits generated/current outputs.
const fakeRunner = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const attempt=path.dirname(process.env.CAN_GENERATION_SESSION_FILE);
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{input+=part});
process.stdin.on('end',async()=>{
 const capture=JSON.parse(fs.readFileSync(path.join(attempt,'capture.json'),'utf8'));
 const required=Object.entries(capture.handles).filter(([,target])=>target.required).map(([handle])=>handle);
 for(let index=0;index<400;index++){
  if(required.every(handle=>fs.existsSync(path.join(attempt,'candidates',handle,'submission.json')))){
   console.log(JSON.stringify({type:'thread.started',thread_id:'deterministic-acceptance-fixture'}));
   console.log(JSON.stringify({status:'ok'}));process.exit(0);
  }
  await new Promise(done=>setTimeout(done,25));
 }
 process.exit(1);
});
`;

// This producer journey deliberately holds the real child process open. It
// exercises on-disk request recovery across imports/processes without any AI.
async function verifyRequestReplay({ clone, baseline, baseContext, status }) {
  const unit = status.body.units.find(unit => unit.kind === 'style');
  assert.ok(unit, 'The original fixture must own a named style generation unit');
  // A bounded original style declaration avoids importing the full app's
  // unrelated reusable-trait ownership ambiguity into this protocol journey.
  const root = join(clone, 'request-replay');
  await mkdir(join(root, 'can.generated'), { recursive: true });
  await cp(join(fixture, 'can.gen.toml'), join(root, 'can.gen.toml'));
  const style = (await readFile(join(fixture, 'PromptStudio.can'), 'utf8'))
    .split('\n').find(line => line.startsWith(' style Surface '));
  assert.ok(style);
  await writeFile(join(root, 'Replay.can'), `app RequestReplay\nGiven\nWhen\nThen\n${style}\n page / title="Replay"\n  card "Replay" $Surface\n`);
  const request = async (id, operation, params, ctx = baseContext) => {
    const result = await dispatchControl(JSON.stringify({ version: 1, request_id: id, operation, root, ...params }), ctx);
    return { code: result.code, body: JSON.parse(result.envelope) };
  };
  const runner = join(clone, 'replay-runner.cjs');
  const log = join(clone, 'replay-launches.jsonl');
  await writeFile(runner, String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const attempt=path.dirname(process.env.CAN_GENERATION_SESSION_FILE);
process.stdin.resume();process.stdin.on('end',async()=>{
 const capture=JSON.parse(fs.readFileSync(path.join(attempt,'capture.json'),'utf8'));
 const binding=JSON.parse(fs.readFileSync(process.env.CAN_GENERATION_SESSION_FILE,'utf8'));
 fs.appendFileSync(path.join(__dirname,'replay-launches.jsonl'),JSON.stringify({request_id:capture.request_id,pid:process.pid,fence:binding.fence})+'\n');
 for(let index=0;index<800;index++){
  if(fs.existsSync(path.join(attempt,'release-runner-'+binding.fence))){
   fs.writeFileSync(path.join(attempt,'runner-finished-'+binding.fence),'done');
   console.log(JSON.stringify({type:'thread.started',thread_id:'request-replay-fixture'}));
   console.log(JSON.stringify({status:'ok'}));process.exit(0);
  }
  await new Promise(done=>setTimeout(done,25));
 }
 process.exit(1);
});
`);
  await chmod(runner, 0o755);
  const launches = async () => existsSync(log)
    ? (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const waitFor = async (description, predicate, diagnose = () => undefined) => {
    for (let index = 0; index < 400; index++) {
      if (await predicate()) return;
      const failure = diagnose();
      if (failure !== undefined) throw new Error(`${description}: ${JSON.stringify(failure)}`);
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error(`Timed out waiting for ${description}`);
  };
  const params = { files: ['Replay.can'], mode: 'fresh', accept: false, max_attempts: 1, timeout_seconds: 30 };
  const submissions = [];
  let originalSession;
  const ctx = { ...baseContext, resolveExecutable: async () => runner,
    onSession: session => {
      originalSession ??= session.context();
      submissions.push(session.submit(session.id, session.context().allowed.flatMap(target => {
        const path = join(fixture, 'can.generated', unit.id, savedPathFor(target.role, target.filename));
        return existsSync(path) ? [{ target: target.handle, role: target.role, content_text: readFileSync(path, 'utf8') }] : [];
      })));
    },
  };
  const input = id => JSON.stringify({ version: 1, request_id: id, operation: 'generate', root, ...params });
  const childCode = `const {dispatchControl}=await import(${JSON.stringify(pathToFileURL(join(workspace, 'packages/cloudflare/dist/generation/controls.js')).href)});
const result=await dispatchControl(process.argv[1],{resolveExecutable:async()=>process.argv[2],mcpBridge:null,codexHome:process.argv[3]});
console.log(JSON.stringify(result));`;
  const reopen = async text => {
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', childCode, text, runner, baseContext.codexHome],
      { cwd: workspace, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout);
    return { code: result.code, body: JSON.parse(result.envelope) };
  };
  const attemptDir = id => join(root, '.can/gen/attempts', attemptFor(id, 0));
  let interrupted;
  const live = [];
  const completed = promise => { live.push(promise); return promise; };
  const pendingIfBusy = promise => promise.catch(error => {
    if (error.code === 'request-in-flight' && error.exit === EXIT_UNKNOWN) return { state: 'unknown' };
    throw error;
  });
  const releaseRunner = async (dir, fence = 0) => writeFile(join(dir, `release-runner-${fence}`), 'release');
  try {
    const id = `replay-live-${randomUUID()}`;
    const observed = [];
    const competing = [request(id, 'generate', params, ctx), request(id, 'generate', params, ctx)]
      .map(promise => completed(promise.then(result => { observed.push(result); return result; })));
    await waitFor('the single live runner', async () => (await launches()).some(entry => entry.request_id === id),
      () => observed.find(result => result.code !== EXIT_UNKNOWN) ?? (observed.length === competing.length ? observed : undefined));
    const captured = await readFile(join(attemptDir(id), 'capture.json'), 'utf8');
    const replayBaseline = await currentBytes(root);
    const pending = await Promise.race(competing);
    assert.equal(pending.code, EXIT_UNKNOWN, 'A concurrent identical request must report unknown without relaunching');
    const changed = await request(id, 'generate', { ...params, mode: 'prepare' }, ctx);
    assert.equal(changed.code, EXIT_CONFLICT, 'Changed input conflicts even while the original runner is live');
    assert.equal(changed.body.error?.code, 'request-conflict');
    const reopened = await reopen(input(id));
    assert.equal(reopened.code, EXIT_UNKNOWN, 'A fresh host must recover pending work without a launch');
    assert.equal(await readFile(join(attemptDir(id), 'capture.json'), 'utf8'), captured, 'Resends preserve the original capture');
    assert.equal((await launches()).filter(entry => entry.request_id === id).length, 1);
    await Promise.all(submissions);
    await releaseRunner(attemptDir(id));
    const settled = await Promise.all(competing);
    const terminal = settled.find(result => result.code === 0);
    assert.ok(terminal, JSON.stringify(settled));
    assert.equal(terminal.body.state, 'candidate');
    assert.equal(terminal.body.complete, true);
    assert.deepEqual(await request(id, 'generate', params, ctx), terminal, 'Terminal resend returns the recorded outcome');
    assert.equal((await launches()).filter(entry => entry.request_id === id).length, 1);

    // Bypass only the top-level control dispatcher, retaining the same real
    // captured recipe/source/targets and child process. This proves that the
    // lifecycle owner also arbitrates direct callers before launch.
    const capture = JSON.parse(captured);
    const directOptions = async (requestId, recipe = capture.recipes[0]) => {
      const dir = attemptDir(requestId);
      await mkdir(dir, { recursive: true });
      await cp(join(attemptDir(id), 'snapshot'), join(dir, 'snapshot'), { recursive: true });
      await writeFile(join(dir, 'capture.json'), JSON.stringify({ ...capture, request_id: requestId }));
      return { request_id: requestId, input: { source: capture.source_digest, unit: unit.id, runner: recipe.runner },
        recipe, source_digest: capture.source_digest, allowed: originalSession.allowed,
        required: Object.entries(capture.handles).filter(([, target]) => target.required).map(([handle]) => handle),
        prompt: capture.instructions, snapshotDir: join(dir, 'snapshot'), attemptDir: dir,
        stateDir: join(root, '.can/gen'), coordinationRoot: root, mcpBridge: null,
        codexHome: baseContext.codexHome, resolveExecutable: async () => runner, onSession: ctx.onSession };
    };
    const directId = `replay-direct-${randomUUID()}`;
    const direct = await directOptions(directId);
    const directResults = [];
    const directCalls = [pendingIfBusy(executeJob(direct)), pendingIfBusy(executeJob(direct))]
      .map(promise => completed(promise.then(result => { directResults.push(result); return result; })));
    await waitFor('the direct lifecycle runner', async () => (await launches()).some(entry => entry.request_id === directId),
      () => directResults.length === 2 ? directResults : undefined);
    assert.equal((await Promise.race(directCalls)).state, 'unknown');
    await assert.rejects(executeJob({ ...direct, input: { ...direct.input, changed: true } }), { code: 'request-conflict' });
    assert.equal((await launches()).filter(entry => entry.request_id === directId).length, 1);
    await Promise.all(submissions);
    await releaseRunner(direct.attemptDir);
    const directTerminal = (await Promise.all(directCalls)).find(outcome => outcome.state === 'candidate');
    assert.ok(directTerminal);
    assert.deepEqual(await executeJob(direct), directTerminal);

    // Pause after the durable claim, before attempt metadata or any child
    // exists. Explicit reset must also release this interrupted admission.
    const prelaunchId = `replay-prelaunch-reset-${randomUUID()}`;
    const prelaunch = await directOptions(prelaunchId);
    let probeWaiting = false, releaseProbe;
    const probeGate = new Promise(done => { releaseProbe = done; });
    const blockedLaunch = completed(assert.rejects(executeJob({ ...prelaunch,
      resolveExecutable: async () => { probeWaiting = true; await probeGate; return runner; },
    }), error => error.exit === EXIT_CONFLICT && ['session-superseded', 'request-superseded'].includes(error.code)));
    let recoveredFence;
    try {
      await waitFor('the claimed prelaunch executable probe', async () => probeWaiting);
      await assert.rejects(readAttempt(prelaunch.attemptDir), { code: 'unknown-session' });
      assert.equal((await executeJob(prelaunch)).state, 'unknown', 'The paused probe already owns a durable claim');
      recoveredFence = await resetAttempt({ attemptDir: prelaunch.attemptDir,
        stateDir: prelaunch.stateDir, coordinationRoot: root });
    } finally { releaseProbe(); }
    await blockedLaunch;
    assert.equal((await launches()).filter(entry => entry.request_id === prelaunchId).length, 0,
      'An admission fenced during executable probing must never launch');
    const recoveredLaunch = completed(executeJob(prelaunch));
    await waitFor('the explicitly recovered prelaunch request', async () => (await launches())
      .some(entry => entry.request_id === prelaunchId && entry.fence === recoveredFence));
    await Promise.all(submissions); await releaseRunner(prelaunch.attemptDir, recoveredFence);
    const recoveredTerminal = await recoveredLaunch;
    assert.equal(recoveredTerminal.state, 'candidate');
    assert.equal(recoveredTerminal.fence, recoveredFence);
    assert.deepEqual(await executeJob(prelaunch), recoveredTerminal, 'Explicit prelaunch recovery records a replayable outcome');
    assert.equal((await launches()).filter(entry => entry.request_id === prelaunchId).length, 1);

    // Resume remains behind its normal unsupported capability gate. The
    // explicit fixture override exercises only the held local protocol, using
    // the actual Claude adapter's resume argv and a deterministic executable;
    // it does not qualify a provider or alter production preflight.
    const recordedId = `replay-resume-recorded-${randomUUID()}`;
    const recorded = await directOptions(recordedId, { ...capture.recipes[0], runner: 'claude-code', native: {} });
    await assert.rejects(executeJob(recorded), { code: 'unsupported-capability' });
    const recording = completed(executeJob({ ...recorded, preflight: () => {} }));
    await waitFor('the fixture-only resume recording', async () => (await launches()).some(entry => entry.request_id === recordedId));
    await Promise.all(submissions); await releaseRunner(recorded.attemptDir);
    assert.equal((await recording).state, 'candidate');
    const resumeId = `replay-resume-${randomUUID()}`;
    const resumeTarget = await directOptions(resumeId, recorded.recipe);
    const resume = { request_id: resumeId, input: { recording: recordedId, source: capture.source_digest },
      recordedAttemptDir: recorded.attemptDir, capture_digest: capture.source_digest, prompt: capture.instructions,
      attemptDir: resumeTarget.attemptDir, stateDir: recorded.stateDir, coordinationRoot: root,
      allowed: recorded.allowed, required: recorded.required, mcpBridge: null, codexHome: baseContext.codexHome,
      resolveExecutable: async () => runner, onSession: ctx.onSession };
    const originalFence = await readFence(recorded.attemptDir);
    await assert.rejects(resumeSession(resume), { code: 'unsupported-capability' });
    assert.equal(await readFence(recorded.attemptDir), originalFence, 'A held adapter refuses before fencing the recording');
    const resumeCalls = [pendingIfBusy(resumeSession({ ...resume, preflight: () => {} })), pendingIfBusy(resumeSession({ ...resume, preflight: () => {} }))]
      .map(promise => completed(promise));
    await waitFor('the one fixture-only resumed runner', async () => (await launches()).some(entry => entry.request_id === resumeId));
    assert.equal((await Promise.race(resumeCalls)).state, 'unknown');
    assert.equal(await readFence(recorded.attemptDir), originalFence + 1, 'Only the admitted resume advances the original fence');
    await Promise.all(submissions); await releaseRunner(resume.attemptDir);
    const resumed = (await Promise.all(resumeCalls)).find(outcome => outcome.state === 'candidate');
    assert.ok(resumed);
    assert.deepEqual(await resumeSession({ ...resume, preflight: () => {} }), resumed,
      'Terminal resume replay precedes the now-superseded original recording check');
    assert.equal((await launches()).filter(entry => entry.request_id === resumeId).length, 1);

    const resetId = `replay-reset-${randomUUID()}`;
    const reset = await directOptions(resetId);
    const oldRun = completed(assert.rejects(executeJob(reset), { code: 'request-superseded' }));
    await waitFor('the original reset runner', async () => (await launches()).some(entry => entry.request_id === resetId));
    await Promise.all(submissions);
    const nextFence = await resetAttempt({ attemptDir: reset.attemptDir, stateDir: reset.stateDir, coordinationRoot: root });
    const replacement = completed(executeJob(reset));
    await waitFor('the explicitly reset replacement', async () => (await launches()).some(entry => entry.request_id === resetId && entry.fence === nextFence));
    await Promise.all(submissions);
    await releaseRunner(reset.attemptDir, nextFence - 1); await oldRun;
    const pendingReplacement = await executeJob(reset);
    assert.equal(pendingReplacement.state, 'unknown', 'Late old completion cannot replace the new pending request');
    assert.equal(pendingReplacement.fence, nextFence);
    assert.equal((await readAttempt(reset.attemptDir)).fence, nextFence, 'Late completion preserves the replacement runner metadata');
    await releaseRunner(reset.attemptDir, nextFence);
    const replacementOutcome = await replacement;
    assert.equal(replacementOutcome.state, 'candidate');
    assert.deepEqual(await executeJob(reset), replacementOutcome, 'Only the explicit replacement publishes the terminal outcome');
    assert.equal((await launches()).filter(entry => entry.request_id === resetId).length, 2);

    const crashId = `replay-interrupted-${randomUUID()}`;
    interrupted = spawn(process.execPath, ['--input-type=module', '-e', childCode, input(crashId), runner, baseContext.codexHome],
      { cwd: workspace, stdio: 'ignore' });
    const stopped = once(interrupted, 'close');
    await waitFor('the interrupted host runner', async () => (await launches()).some(entry => entry.request_id === crashId));
    const interruptedCapture = await readFile(join(attemptDir(crashId), 'capture.json'), 'utf8');
    interrupted.kill('SIGKILL');
    await stopped;
    interrupted = undefined;
    const recovered = await reopen(input(crashId));
    assert.equal(recovered.code, EXIT_UNKNOWN, 'A host killed after launch must not make the request absent');
    assert.equal((await launches()).filter(entry => entry.request_id === crashId).length, 1);
    assert.equal(await readFile(join(attemptDir(crashId), 'capture.json'), 'utf8'), interruptedCapture);
    assert.equal((await reopen(JSON.stringify({ ...JSON.parse(input(crashId)), mode: 'prepare' }))).code, EXIT_CONFLICT);
    await releaseRunner(attemptDir(crashId));
    await waitFor('the orphan runner to finish', async () => existsSync(join(attemptDir(crashId), 'runner-finished-0')));
    assert.equal((await reopen(input(crashId))).code, EXIT_UNKNOWN, 'An unrecorded completion remains unknown after the child exits');
    assert.deepEqual(await currentBytes(root), replayBaseline, 'Concurrent/interrupted generation never promotes current groups');
    assert.deepEqual(await currentBytes(clone), baseline, 'The original app current groups remain untouched');
    return { name: 'request-replay', concurrent_launches: 1, interrupted_launches: 1,
      pending_reopen: 'unknown', interrupted_reopen: 'unknown', terminal_replayed: true,
      direct_lifecycle_launches: 1, prelaunch_reset_launches: 1, fixture_resume_launches: 1,
      explicit_reset_launches: 2, current_preserved: true };
  } finally {
    if (interrupted !== undefined && interrupted.exitCode === null && interrupted.signalCode === null) {
      const closed = once(interrupted, 'close'); interrupted.kill('SIGKILL'); await closed;
    }
    for (const { pid, request_id, fence } of await launches()) {
      if (existsSync(join(attemptDir(request_id), `runner-finished-${fence}`))) continue;
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await Promise.allSettled(live);
    // A killed host cannot restore its readonly snapshot in finally. Only
    // this integration's disposable snapshot trees need cleanup permissions.
    const writable = async path => {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await writable(child);
        else if (entry.isFile()) await chmod(child, 0o600);
      }
    };
    for (const { request_id } of await launches()) {
      const snapshot = join(attemptDir(request_id), 'snapshot');
      if (existsSync(snapshot)) await writable(snapshot);
    }
  }
}

await assertNoDevSession();
const reportsRoot = join(workspace, 'output/prompt-pipeline/acceptance');
await mkdir(reportsRoot, { recursive: true });
const output = await mkdtemp(join(reportsRoot, 'run-'));
const clone = await mkdtemp(join(dirname(fixture), 'prompt-acceptance-'));
const originalEnvironment = { compiler: process.env.CAN_COMPILER_BIN, path: process.env.PATH };
const outcomes = [];
let complete = false;
try {
  for (const file of ['PromptStudio.can', 'can.gen.toml', 'playwright.config.ts', 'can.generated']) {
    await cp(join(fixture, file), join(clone, file), { recursive: true });
  }
  await mkdir(join(clone, 'playwright'));
  await cp(join(fixture, 'playwright/app.spec.ts'), join(clone, 'playwright/app.spec.ts'));
  const runner = join(clone, 'deterministic-runner.cjs');
  await writeFile(runner, fakeRunner);
  await chmod(runner, 0o755);
  process.env.CAN_COMPILER_BIN = compiler;
  process.env.PATH = [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter);
  const baseContext = { resolveExecutable: async () => runner, mcpBridge: null, codexHome: join(clone, 'empty-codex-home') };
  const request = async (id, operation, params, ctx = baseContext) => {
    const result = await dispatchControl(JSON.stringify({ version: 1, request_id: id, operation, root: clone, ...params }), ctx);
    return { code: result.code, body: JSON.parse(result.envelope) };
  };

  // Refresh cloned source association before taking the all-files baseline.
  // Later failed checks must preserve even these refreshed unit records.
  const status = await request(`acceptance-status-${randomUUID()}`, 'status', { files: ['PromptStudio.can'] });
  assert.equal(status.code, 0, 'Cloned app status must resolve');
  assert.equal(status.body.units.length, 8, 'Fixture must expose all eight generation units');
  const revision = createHash('sha256').update(await readFile(join(clone, 'PromptStudio.can'))).digest('hex');
  for (const unit of status.body.units) {
    assert.match(unit.id, /^u\d+$/);
    const bound = await request(`acceptance-bind-${unit.id}-${randomUUID()}`, 'bind', {
      file: 'PromptStudio.can', start: unit.span.start, end: unit.span.end, revision, unit: unit.id,
    });
    assert.equal(bound.code, 0, `Cloned unit ${unit.id} must retain its identity`);
  }
  const baseline = await currentBytes(clone);
  if (selected.includes('request-replay')) outcomes.push(await verifyRequestReplay({ clone, baseline, baseContext, status }));

  for (const [name, expectedStage] of cases.filter(([name]) => selected.length === 0 || selected.includes(name))) {
    const id = `acceptance-${name}-${randomUUID()}`;
    const submissions = [];
    const context = { ...baseContext,
      onEvent: (phase, detail) => { if (phase === 'acceptance') console.log(detail); },
      onSession: session => {
        const batch = [];
        for (const target of session.context().allowed) {
          const unit = /^(u\d+)-/.exec(target.handle)?.[1];
          assert.ok(unit, 'Output handle must identify its fixture unit');
          const saved = savedPathFor(target.role, target.filename);
          const path = join(fixture, 'can.generated', unit, saved);
          // Optional output handles are submitted only when the saved fixture owns them.
          if (!existsSync(path)) continue;
          const record = JSON.parse(readFileSync(join(fixture, 'can.generated', unit, 'unit.json'), 'utf8'));
          let bytes = readFileSync(path);
          if (name === 'broken-keyword' && record.source.kind === 'keyword' && saved === 'implementation.js') {
            bytes = Buffer.from('export function canonicalKey(value){return "collision";}\n');
          }
          if (name === 'broken-view' && record.source.kind === 'view' && saved === 'implementation.js') {
            bytes = Buffer.from('export function render(){return "";}\nexport function mount(root){root.setAttribute("data-enhanced","true");return ()=>root.removeAttribute("data-enhanced");}\n');
          }
          batch.push({ target: target.handle, role: target.role, ...(target.role === 'asset'
            ? { content_base64: bytes.toString('base64') } : { content_text: bytes.toString('utf8') }) });
        }
        submissions.push(session.submit(session.id, batch));
      },
    };
    const result = await request(id, 'retry', { files: ['PromptStudio.can'], accept: true }, context);
    await Promise.all(submissions);
    const gateSource = join(clone, '.can/gen/checks', runFor('run', id));
    const gateOutput = join(output, name);
    if (existsSync(gateSource)) await cp(gateSource, gateOutput, { recursive: true });
    const report = JSON.parse(await readFile(join(gateOutput, 'report.json'), 'utf8'));
    if (expectedStage !== null) {
      assert.notEqual(result.code, 0, `${name} must fail`);
      assert.equal(result.body.error?.code, 'app-acceptance-failed', `${name} must reach the real app gate`);
      assert.equal(report.ok, false);
      assert.equal(report.checks.at(-1)?.stage, expectedStage, `${name} must fail at its expected phase`);
      if (expectedStage === 'test') {
        const native = JSON.parse(await readFile(join(gateOutput, '1/test.stdout.log'), 'utf8'));
        assert.equal(native.command, 'test');
        assert.ok(native.executed > 0, 'The broken keyword must reach actual example execution');
        assert.equal(native.ok, false);
      } else {
        const browser = JSON.parse(await readFile(join(gateOutput, '1/playwright.json'), 'utf8'));
        assert.ok(browser.stats.unexpected > 0, 'The broken view must fail a real browser test');
        const receipt = JSON.parse(await readFile(join(gateOutput, '1/browser-session.json'), 'utf8'));
        assert.ok(receipt.browserNavigations > 0, 'The failed journey must visit the candidate app');
        assert.equal(receipt.closed, true);
      }
      assert.deepEqual(await currentBytes(clone), baseline, `${name} must preserve every current file and unit record`);
    } else {
      assert.equal(result.code, 0, 'The saved working app must pass actual checks');
      assert.equal(result.body.state, 'accepted');
      assert.equal(result.body.complete, true);
      assert.equal(result.body.qualified, true);
      assert.equal(result.body.accepted.units.length, 8, 'All eight candidate units must promote together');
      assert.equal(report.ok, true);
      assert.deepEqual(report.checks.map(check => check.stage), ['compile', 'build', 'test', 'playwright']);
    }
    outcomes.push({ name, exit: result.code, state: result.body.state, error_code: result.body.error?.code ?? null,
      expected_failure_stage: expectedStage, current_preserved: expectedStage !== null, gate_report: join(gateOutput, 'report.json') });
    await assertNoDevSession();
  }
  complete = true;
} finally {
  if (originalEnvironment.compiler === undefined) delete process.env.CAN_COMPILER_BIN;
  else process.env.CAN_COMPILER_BIN = originalEnvironment.compiler;
  if (originalEnvironment.path === undefined) delete process.env.PATH;
  else process.env.PATH = originalEnvironment.path;
  await writeFile(join(output, 'summary.json'), `${JSON.stringify({ version: 1, ok: complete,
    scope: 'real app acceptance and atomic promotion with deterministic saved-output submissions; zero AI calls', outcomes }, null, 2)}\n`);
  await assertNoDevSession();
  await rm(clone, { recursive: true, force: true });
  console.log(`Acceptance verification summary: ${join(output, 'summary.json')}`);
}
