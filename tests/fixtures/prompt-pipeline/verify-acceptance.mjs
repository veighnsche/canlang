#!/usr/bin/env node
/** Real candidate checks with deterministic MCP submissions; no model invocation. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixture = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(fixture, '../../..');
const compiler = join(workspace, 'compiler/target/debug/can');
const cases = [['broken-keyword', 'test'], ['broken-view', 'playwright'], ['working-app', null]];
const selected = process.argv.slice(2);
if (selected.some(name => !cases.some(([candidate]) => candidate === name))) {
  throw new Error(`Expected case names: ${cases.map(([name]) => name).join(', ')}`);
}
const { dispatchControl, runFor, savedPathFor } = await import(pathToFileURL(join(workspace, 'packages/cloudflare/dist/generation/controls.js')).href);
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
