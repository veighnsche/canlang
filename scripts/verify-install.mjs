#!/usr/bin/env node
/** Exercise the real archive from an external application with no developer PATH. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const checkout = fileURLToPath(new URL('..', import.meta.url));
const archive = resolve(process.argv[2] ?? join(checkout, `output/install/can-0.1.0-${process.platform}-${process.arch}.tar.gz`));
// A failed new artifact must not leave a previous passing report in place.
const reportPath = join(dirname(archive), 'verification.json');
rmSync(reportPath, { force: true });
const scratch = realpathSync(mkdtempSync('/tmp/can-install-'));
const home = join(scratch, 'home with spaces'), app = join(scratch, 'external app');
mkdirSync(home); mkdirSync(app); mkdirSync(join(scratch, 'tmp'));
const env = { HOME: home, TMPDIR: join(scratch, 'tmp') + '/', PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8' };
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
let can;
const results = [];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: app, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.error ?? ''}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
function check(label, fn) { fn(); results.push(label); console.log(`PASS ${label}`); }
try {
  check('one-command checksum-verified install', () => run('/bin/sh', [join(checkout, 'scripts/install.sh'), '--archive', archive, '--checksum', digest, '--version', '0.1.0']));
  can = join(home, '.can/bin/can');
  const installation = realpathSync(join(home, '.can/current'));
  check('compiler version', () => assert.match(run(can, ['--version']), /^can 0\.1\.0/));
  copyFileSync(join(checkout, 'compiler/tests/fixtures/construct-help-first-profile.can'), join(app, 'Office.can'));
  check('source check and policy with installed catalog', () => { run(can, ['check', 'Office.can']); run(can, ['policy', 'Office.can']); });
  let artifact;
  check('compile complete source with inline examples', () => { artifact = JSON.parse(run(can, ['compile', '--format=json', '--native-scenario-receipts', 'Office.can'])); writeFileSync(join(app, 'Office.artifact.json'), JSON.stringify(artifact)); });
  check('installed build with release metadata', () => assert.equal(JSON.parse(run(can, ['build', '--artifact', 'Office.artifact.json'])).ok, true));
  check('installed inline examples on real local engine', () => { const tested = JSON.parse(run(can, ['test', '--artifact', 'Office.artifact.json'])); assert.equal(tested.ok, true); assert.ok(tested.executed > 0); });
  check('installed module staging', () => assert.equal(JSON.parse(run(can, ['run', '--artifact', 'Office.artifact.json'])).ok, true));
  check('generation dry-run without provider setup', () => run(can, ['gen', 'Office.can', '--dry-run']));
  check('installed documentation renderer', () => assert.ok(run(can, ['docs', 'Office.can']).length > 100));
  check('bundled deployment CLI', () => assert.match(run(join(installation, 'libexec/wrangler'), ['--version'], { env: { ...env, PATH: `${installation}/libexec:/usr/bin:/bin`, WRANGLER_SEND_METRICS: 'false' } }), /4\.116\.0/));
  check('deployment bundling without account credentials', () => {
    writeFileSync(join(app, 'worker.js'), 'export default {fetch(){return new Response(\"installed\")}}');
    writeFileSync(join(app, 'wrangler.toml'), 'name = \"can-install-smoke\"\nmain = \"worker.js\"\ncompatibility_date = \"2026-07-15\"\n');
    run(join(installation, 'libexec/wrangler'), ['deploy', '--dry-run', '--outdir', 'worker-output', '--config', 'wrangler.toml'], { env: { ...env, PATH: `${installation}/libexec:/usr/bin:/bin`, WRANGLER_SEND_METRICS: 'false' } });
  });
  check('checkout reads denied by bundled Node', () => {
    run(join(installation, 'libexec/node'), ['--permission', `--allow-fs-read=${installation}`, `--allow-fs-read=${scratch}`, '-e',
      `const fs=require('node:fs');try{fs.readFileSync(${JSON.stringify(join(checkout, 'package.json'))});process.exit(1)}catch(e){if(e.code!=='ERR_ACCESS_DENIED')throw e}`]);
  });
  check('bundled Node retains native addon support after symbol reduction', () => {
    run(join(installation, 'libexec/node'), ['--input-type=module', '-e',
      `import {createRequire} from 'node:module';import assert from 'node:assert/strict';
       const sharp=createRequire(${JSON.stringify(join(installation, 'package.json'))})('sharp');
       const png=await sharp({create:{width:2,height:2,channels:4,background:'#123456'}}).png().toBuffer();
       assert.equal(png.subarray(1,4).toString(),'PNG');`]);
  });
  check('production install contains no browser or development packages', () => {
    const manifest = JSON.parse(readFileSync(join(installation, 'manifest.json'), 'utf8'));
    for (const name of ['@playwright/test', 'playwright', 'playwright-core', 'typescript', 'vitest', 'turbo', 'happy-dom']) assert.ok(!manifest.packages.some(pkg => pkg.name === name), name);
    assert.equal(existsSync(join(installation, 'browsers')), false);
    assert.equal(existsSync(join(installation, 'libexec/bun')), false);
    assert.deepEqual(Object.keys(manifest.engines), ['node']);
    for (const pkg of manifest.packages) for (const destination of pkg.destinations) assert.equal('devDependencies' in JSON.parse(readFileSync(join(installation, destination, 'package.json'), 'utf8')), false);
  });
  check('browser acceptance refuses missing opt-in development tools', () => {
    const candidate = join(app, 'candidate'); mkdirSync(candidate);
    const module = new URL(`file://${join(installation, 'node_modules/@canlang/cloudflare/dist/generation/acceptance.js')}`).href;
    run(join(installation, 'libexec/node'), ['--input-type=module', '-e',
      `import assert from 'node:assert/strict';import {runAppAcceptance} from ${JSON.stringify(module)};
       await assert.rejects(runAppAcceptance({root:${JSON.stringify(app)},candidateRoot:${JSON.stringify(candidate)},
       files:['Office.can'],compiler:process.execPath,reportDir:${JSON.stringify(join(app, 'missing-browser-report'))}}),
       /Browser development tools are not installed/);`], {env: {...env, CAN_INSTALL_ROOT: installation}});
  });
  check('protected preview lifecycle from external source', () => {
    try {
      const started = JSON.parse(run(can, ['dev', 'start', '--source', 'Office.can', '--app', 'HelpOffice'])); assert.equal(started.ok, true);
      const checked = JSON.parse(run(can, ['dev', 'check', '--app', 'HelpOffice']));
      assert.equal(checked.ok, true, JSON.stringify(checked));
      assert.equal(checked.result.preview, 'ready', JSON.stringify(checked));
      const preview = JSON.parse(run(can, ['dev', 'preview.status', '--app', 'HelpOffice']));
      assert.equal(preview.ok, true, JSON.stringify(preview));
      const opened = JSON.parse(run(can, ['dev', 'preview.open', '--app', 'HelpOffice'])); assert.equal(opened.ok, true, JSON.stringify(opened));
      assert.match(opened.result.url, /^http:\/\/(?:127\.0\.0\.1|localhost):/);
      // An ordinary protected HTTP navigation requires no browser automation dependency.
      const response = run('/usr/bin/curl', ['--silent', '--show-error', '--dump-header', '-', '--output', '/dev/null', opened.result.url]);
      assert.match(response, /^HTTP\/[^ ]+ 303/m);
      assert.match(response, /set-cookie: can_dev_preview=/i);

    } finally { if (can) run(can, ['dev', 'stop', '--app', 'HelpOffice']); }
  });
  check('installed source provisions R2 and Durable Objects without manual dependencies', () => {
    copyFileSync(join(checkout, 'packages/cloudflare/test/fixtures/native-root-files.can'), join(app, 'RootFiles.can'));
    const compiled = JSON.parse(run(can, ['compile', '--format=json', '--native-scenario-receipts', 'RootFiles.can']));
    assert.ok(compiled.runtimeBindings.some(binding => binding.kind === 'r2' && binding.binding === 'FILES'));
    assert.ok(compiled.runtimeBindings.some(binding => binding.kind === 'durable-object' && binding.key === 'RootFiles.Folder'));
    try {
      const started = JSON.parse(run(can, ['dev', 'start', '--source', 'RootFiles.can', '--app', 'RootFiles']));
      assert.equal(started.ok, true, JSON.stringify(started));
      const checked = JSON.parse(run(can, ['dev', 'check', '--app', 'RootFiles']));
      assert.equal(checked.ok, true, JSON.stringify(checked));
      assert.equal(checked.result.preview, 'ready', JSON.stringify(checked));
      const preview = JSON.parse(run(can, ['dev', 'preview.status', '--app', 'RootFiles']));
      assert.equal(preview.ok, true, JSON.stringify(preview));
      const opened = JSON.parse(run(can, ['dev', 'preview.open', '--app', 'RootFiles']));
      assert.equal(opened.ok, true, JSON.stringify(opened));
      const response = run('/usr/bin/curl', ['--silent', '--show-error', '--dump-header', '-', '--output', '/dev/null', opened.result.url]);
      assert.match(response, /^HTTP\/[^ ]+ 303/m);
    } finally { run(can, ['dev', 'stop', '--app', 'RootFiles']); }
  });
  check('installed model-free member queue provisions its owning State automatically', () => {
    writeFileSync(join(app, 'QueueOnly.can'), `app QueueOnly
context
 queue Jobs type=text
Given
When
 scenario submit(title:text) by=members
  do send Jobs.publish {value=title} as queued
Then
`);
    try {
      const started = JSON.parse(run(can, ['dev', 'start', '--source', 'QueueOnly.can', '--app', 'QueueOnly']));
      assert.equal(started.ok, true, JSON.stringify(started));
      const checked = JSON.parse(run(can, ['dev', 'check', '--app', 'QueueOnly']));
      assert.equal(checked.ok, true, JSON.stringify(checked));
      assert.equal(checked.result.preview, 'ready', JSON.stringify(checked));
      const preview = JSON.parse(run(can, ['dev', 'preview.status', '--app', 'QueueOnly']));
      assert.equal(preview.ok, true, JSON.stringify(preview));
      const opened = JSON.parse(run(can, ['dev', 'preview.open', '--app', 'QueueOnly']));
      assert.equal(opened.ok, true, JSON.stringify(opened));
    } finally { run(can, ['dev', 'stop', '--app', 'QueueOnly']); }
  });
  const report = { platform: `${process.platform}-${process.arch}`, archive, checks: results, developerPath: env.PATH, passed: true };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (!process.env.CAN_KEEP_INSTALL_TEST) rmSync(scratch, { recursive: true, force: true });
  else console.log(`Retained verification installation: ${scratch}`);
}
