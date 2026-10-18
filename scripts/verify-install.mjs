#!/usr/bin/env node
/** Exercise the real archive from an external application with no developer PATH. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const checkout = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
const archive = resolve(process.argv[2] ?? join(checkout, `output/install/can-${version}-${process.platform}-${process.arch}.tar.gz`));
// A failed new artifact must not leave a previous passing report in place.
const reportPath = join(dirname(archive), 'verification.json');
rmSync(reportPath, { force: true });
const scratch = realpathSync(mkdtempSync('/tmp/can-install-'));
const home = join(scratch, 'home with spaces'), app = join(scratch, 'external app');
mkdirSync(home); mkdirSync(app); mkdirSync(join(scratch, 'tmp'));
// /usr/bin can itself contain Node/npm. Expose only the OS utilities needed by
// the consumer, so native and JavaScript commands cannot use a host toolchain.
const systemBin = join(scratch, 'system-bin'), systemTools = [];
mkdirSync(systemBin);
for (const name of ['sh', 'bash', 'uname', 'curl', 'tar', 'gzip', 'awk', 'sed', 'tr', 'mktemp', 'mkdir', 'rmdir',
  'dirname', 'basename', 'cat', 'cut', 'mv', 'ln', 'rm', 'readlink', 'touch', 'grep', 'getconf', 'sha256sum',
  'shasum', 'env', 'ps', 'chmod', 'cp', 'find', 'sort', 'head', 'tail', 'wc', 'sleep']) {
  const found = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', name], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  const executable = found.stdout?.trim();
  if (found.status !== 0 || !executable?.startsWith('/')) continue;
  symlinkSync(executable, join(systemBin, name)); systemTools.push(name);
}
const env = { HOME: home, TMPDIR: join(scratch, 'tmp') + '/', PATH: systemBin,
  SHELL: process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash', LANG: 'en_US.UTF-8' };
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
let can;
const results = [];
const report = { platform: `${process.platform}-${process.arch}`, archive, checks: results, developerPath: env.PATH, passed: false,
  host: { platform: process.platform, arch: process.arch, kernel: release() },
  environment: { disposableHome: true, installer: 'canonical install.sh supplied to /bin/bash -s -- on stdin',
    path: 'Task-owned allowlist of OS utilities resolved from /usr/bin:/bin; external language tools excluded.', systemTools } };
let currentCheck;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: app, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.error ?? ''}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
function check(label, fn) { currentCheck = label; fn(); results.push(label); console.log(`PASS ${label}`); }
function inventory(root) {
  const sizes = { installedFileBytes: 0, allocatedFileBytes: 0, installedDiskBytes: 0, files: 0,
    measurement: 'Installed version directory only, including .can-install-version; excludes parent directories, public symlinks and app state. File bytes are lstat.size; allocated bytes are lstat.blocks*512 including directories.' };
  const native = [];
  function walk(path) {
    const info = lstatSync(path);
    assert.ok(!info.isSymbolicLink(), `unexpected installed payload symlink: ${path}`);
    sizes.installedDiskBytes += info.blocks * 512;
    if (info.isDirectory()) { for (const name of readdirSync(path)) walk(join(path, name)); return; }
    assert.ok(info.isFile());
    sizes.installedFileBytes += info.size; sizes.allocatedFileBytes += info.blocks * 512; sizes.files++;
    if (process.platform !== 'linux' || !(info.mode & 0o111 || /\.(?:node|so(?:\.[\w.-]+)?)$/.test(path))) return;
    const header = Buffer.alloc(20), descriptor = openSync(path, 'r');
    try { readSync(descriptor, header, 0, header.length, 0); } finally { closeSync(descriptor); }
    if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return;
    assert.equal(header[4], 2, `native binary is not 64-bit: ${path}`);
    assert.equal(header[5], 1, `native binary is not little-endian: ${path}`);
    assert.equal(header.readUInt16LE(18), 62, `native binary is not x86_64: ${path}`);
    native.push(relative(root, path));
  }
  walk(root);
  sizes.installerMetadataFileBytes = statSync(join(root, '.can-install-version')).size;
  return { sizes, native };
}
try {
  check('clean PATH excludes external language toolchains', () => run('/bin/bash', ['-c',
    'for tool in node nodejs npm npx bun bunx rustc cargo deno tsc; do if command -v "$tool" >/dev/null 2>&1; then printf "unexpected host tool: %s\\n" "$tool" >&2; exit 1; fi; done']));
  check('one-command checksum-verified install', () => {
    const expected = readFileSync(`${archive}.sha256`, 'utf8').match(/^([0-9a-f]{64})[ \t]+\*?([^\r\n]+)\r?\n?$/);
    assert.ok(expected && expected[1] === digest && expected[2] === basename(archive), 'matching archive SHA-256 sidecar is required');
    const installer = readFileSync(join(dirname(archive), 'install.sh'));
    assert.ok(installer.equals(readFileSync(join(checkout, 'scripts/install.sh'))), 'installer sidecar differs from canonical source');
    run('/bin/bash', ['-s', '--', '--archive', archive, '--checksum', digest, '--version', version], { input: installer });
  });
  can = join(home, '.can/bin/can');
  const installation = realpathSync(join(home, '.can/current'));
  check('compiler version', () => { report.compilerVersion = run(can, ['--version']).trim(); assert.ok(report.compilerVersion.startsWith(`can ${version}`)); });
  check('native development-server identity and non-starting help', () => {
    report.devServerVersion = run(join(installation, 'libexec/can-dev'), ['--version']).trim();
    assert.equal(report.devServerVersion, `can-dev ${version} (can.dev.control.v1)`);
    assert.equal(JSON.parse(run(can, ['dev', '--help'])).result.schema, 'can.dev.control-help.v1');
    assert.equal(existsSync(join(installation, 'node_modules/@canlang/cloudflare/dist/dev/control-cli.js')), false);
    assert.equal(JSON.parse(readFileSync(join(installation, 'node_modules/@canlang/cloudflare/package.json'))).bin['can-dev'], undefined);
    const override = join(scratch, 'private override');
    writeFileSync(override, '#!/bin/sh\nprintf "override %s\\n" "$#"\nexit 7\n'); chmodSync(override, 0o755);
    const selected = spawnSync(can, ['dev', 'status', '--root', app], { cwd: app, env: { ...env, CAN_DEV_BIN: override }, encoding: 'utf8', timeout: 5000 });
    assert.equal(selected.status, 7); assert.equal(selected.stdout, 'override 3\n');
  });
  check('exact installed bytes match the archive payload', () => {
    const { sizes, native } = inventory(installation);
    const sizePath = join(dirname(archive), 'size-report.json');
    const produced = JSON.parse(readFileSync(sizePath, 'utf8'));
    assert.equal(produced.archive, basename(archive)); assert.equal(produced.downloadBytes, statSync(archive).size);
    assert.equal(produced.installedFileBytes, sizes.installedFileBytes - sizes.installerMetadataFileBytes);
    report.downloadBytes = produced.downloadBytes; Object.assign(report, sizes);
    writeFileSync(sizePath, JSON.stringify({ ...produced, actualInstallation: sizes }, null, 2) + '\n');
    if (process.platform === 'linux') {
      report.host.osRelease = readFileSync('/etc/os-release', 'utf8');
      const compare = (a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0]) || Number(a.split('.')[1]) - Number(b.split('.')[1]);
      const files = native.map(path => {
        // Producer inspection only; consumers never need binutils.
        const elf = execFileSync('readelf', ['--dynamic', '--version-info', join(installation, path)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        const glibc = [...new Set([...elf.matchAll(/GLIBC_(\d+\.\d+)/g)].map(match => match[1]))].sort(compare).at(-1) ?? null;
        return { path, glibc, sharedLibraries: [...elf.matchAll(/Shared library: \[([^\]]+)\]/g)].map(match => match[1]) };
      });
      report.nativeRequirements = { glibc: files.map(file => file.glibc).filter(Boolean).sort(compare).at(-1), files };
      report.compatibilityLimits = [`This archive's native ELF symbols require glibc ${report.nativeRequirements.glibc} or newer; qualification covers the recorded host only.`,
        'Older distributions and other CPU generations were not exercised; listed system shared libraries must also be compatible.'];
    } else report.host.macOS = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
  });
  check('private Node and compatible esbuild/workerd native binaries', () => {
    report.nativeVersions = JSON.parse(run(join(installation, 'libexec/node'), ['-e', `
      const assert=require('node:assert/strict'),{createRequire}=require('node:module'),{realpathSync}=require('node:fs');
      const root=${JSON.stringify(installation)}, requireInstalled=createRequire(root+'/package.json');
      assert.equal(realpathSync(process.execPath),realpathSync(root+'/libexec/node'));
      assert.equal(process.platform,${JSON.stringify(process.platform)}); assert.equal(process.arch,${JSON.stringify(process.arch)});
      const esbuild=createRequire(root+'/node_modules/wrangler/package.json')('esbuild');
      assert.match(esbuild.transformSync('const value: number = 42',{loader:'ts'}).code,/42/);
      const workerd=createRequire(requireInstalled.resolve('miniflare'))('workerd');
      assert.ok(realpathSync(workerd.default).startsWith(root+'/'));
      const cli=require('node:child_process').execFileSync(workerd.default,['--version'],{encoding:'utf8'}).trim();
      console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,
        glibc:process.report.getReport().header.glibcVersionRuntime,esbuild:esbuild.version,workerd:workerd.version,workerdCli:cli,
        miniflare:requireInstalled('miniflare/package.json').version,sharp:requireInstalled('sharp').versions}));
    `]));
    report.host.glibc = report.nativeVersions.glibc;
  });
  copyFileSync(join(checkout, 'compiler/tests/fixtures/construct-help-first-profile.can'), join(app, 'Office.can'));
  check('source check and policy with installed catalog', () => { run(can, ['check', 'Office.can']); run(can, ['policy', 'Office.can']); });
  let artifact;
  check('compile complete source with inline examples', () => { artifact = JSON.parse(run(can, ['compile', '--format=json', '--native-scenario-receipts', 'Office.can'])); writeFileSync(join(app, 'Office.artifact.json'), JSON.stringify(artifact)); });
  check('installed build with release metadata', () => assert.equal(JSON.parse(run(can, ['build', '--artifact', 'Office.artifact.json'])).ok, true));
  check('installed inline examples on real local engine', () => { const tested = JSON.parse(run(can, ['test', '--artifact', 'Office.artifact.json'])); assert.equal(tested.ok, true); assert.ok(tested.executed > 0); });
  check('installed module staging', () => assert.equal(JSON.parse(run(can, ['run', '--artifact', 'Office.artifact.json'])).ok, true));
  check('generation dry-run without provider setup', () => run(can, ['gen', 'Office.can', '--dry-run']));
  check('installed documentation renderer', () => assert.ok(run(can, ['docs', 'Office.can']).length > 100));
  check('bundled deployment CLI', () => {
    const output = run(join(installation, 'libexec/wrangler'), ['--version'], { env: { ...env, PATH: `${installation}/libexec:${env.PATH}`, WRANGLER_SEND_METRICS: 'false' } });
    assert.match(output, /4\.116\.0/); report.nativeVersions.wrangler = output.trim();
  });
  check('deployment bundling without account credentials', () => {
    writeFileSync(join(app, 'worker.js'), 'export default {fetch(){return new Response(\"installed\")}}');
    writeFileSync(join(app, 'wrangler.toml'), 'name = \"can-install-smoke\"\nmain = \"worker.js\"\ncompatibility_date = \"2026-07-15\"\n');
    run(join(installation, 'libexec/wrangler'), ['deploy', '--dry-run', '--outdir', 'worker-output', '--config', 'wrangler.toml'], { env: { ...env, PATH: `${installation}/libexec:${env.PATH}`, WRANGLER_SEND_METRICS: 'false' } });
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
       assert.equal(png.subarray(1,4).toString(),'PNG');
       const decoded=await sharp(png).raw().toBuffer({resolveWithObject:true});
       assert.equal(decoded.info.width,2);assert.equal(decoded.info.height,2);
       assert.deepEqual([...decoded.data.subarray(0,4)],[18,52,86,255]);`]);
  });
  check('production install contains no browser or development packages', () => {
    const manifest = JSON.parse(readFileSync(join(installation, 'manifest.json'), 'utf8'));
    for (const name of ['@playwright/test', 'playwright', 'playwright-core', 'typescript', 'vitest', 'turbo', 'happy-dom']) assert.ok(!manifest.packages.some(pkg => pkg.name === name), name);
    assert.equal(existsSync(join(installation, 'browsers')), false);
    assert.equal(existsSync(join(installation, 'libexec/bun')), false);
    assert.deepEqual(Object.keys(manifest.engines), ['node']);
    for (const pkg of manifest.packages) for (const destination of pkg.destinations) {
      const installed = JSON.parse(readFileSync(join(installation, destination, 'package.json'), 'utf8'));
      assert.equal('devDependencies' in installed, false);
      for (const [field, actual] of [['os', process.platform], ['cpu', process.arch], ...(process.platform === 'linux' ? [['libc', 'glibc']] : [])]) {
        const values = installed[field];
        if (values) assert.ok(!values.includes(`!${actual}`) && (!values.some(value => !value.startsWith('!')) || values.includes(actual)), `${pkg.name}: incompatible ${field}`);
      }
    }
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
  check('installed native manual workflow retains login and data', () => {
    copyFileSync(join(checkout, 'scripts/fixtures/preview-persistence.can'), join(app, 'Preview.can'));
    const journey = join(scratch, 'native-dev-server.json');
    run(join(installation, 'libexec/node'), [join(checkout, 'scripts/verify-installed-dev-server.mjs'), '--installation', installation,
      '--project-root', app, '--report', journey, '--compat-cli', join(checkout, 'packages/cloudflare/dist/dev/control-cli.js')], { timeout: 240000 });
    report.devServerJourney = JSON.parse(readFileSync(journey, 'utf8'));
    assert.equal(report.devServerJourney.ok, true);
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
  report.passed = true;
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.failedCheck = currentCheck; report.error = error.message; report.retainedState = scratch;
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  throw error;
} finally {
  if (report.passed && !process.env.CAN_KEEP_INSTALL_TEST) rmSync(scratch, { recursive: true, force: true });
  else console.log(`Retained verification installation: ${scratch}`);
}
