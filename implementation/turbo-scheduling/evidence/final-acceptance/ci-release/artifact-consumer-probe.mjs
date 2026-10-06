#!/usr/bin/env node
/** One-off acceptance of the exact release payload; never builds or repacks a package. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = realpathSync(fileURLToPath(new URL('../../../../../', import.meta.url)));
const evidenceDirectory = fileURLToPath(new URL('./', import.meta.url));
const payload = join(checkout, 'output/release-artifacts');
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'canlang-release-artifact-consumer-'));
const consumer = join(scratch, 'consumer');
const tarballs = join(scratch, 'tarballs');
const logs = join(scratch, 'logs');
for (const directory of [consumer, tarballs, logs]) mkdirSync(directory);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const groups = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];
const report = { status: 'failed', checkout, payload, scratch, consumer, node: process.version, commands: [], packages: [],
  scope: 'Exact release tarball closure under Bun isolated installation and installed Worker checks; no build, repack, registry publication or native release/adoption.' };
const environment = { ...process.env, TMPDIR: scratch, BUN_INSTALL_CACHE_DIR: join(scratch, 'bun-cache') };
function command(label, executable, args, cwd) {
  console.log(`release artifact consumer: ${label}`);
  const result = spawnSync(executable, args, { cwd, env: environment, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  const stdout = result.stdout ?? '', stderr = result.stderr ?? '';
  const stdoutLog = join(logs, `${label}.stdout.log`), stderrLog = join(logs, `${label}.stderr.log`);
  writeFileSync(stdoutLog, stdout); writeFileSync(stderrLog, stderr);
  report.commands.push({ label, executable, args, cwd, exit: result.status, signal: result.signal, error: result.error?.message ?? null,
    stdoutLog, stdoutSha256: digest(stdout), stderrLog, stderrSha256: digest(stderr) });
  assert.ok(!result.error && result.status === 0 && !result.signal, `${label} failed; raw logs: ${logs}`);
  return stdout;
}

try {
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Use the accepted Node24 profile');
  report.bun = command('bun-version', 'bun', ['--version'], consumer).trim();
  assert.equal(report.bun, '1.4.2');
  const rootManifest = json(join(checkout, 'package.json'));
  assert.deepEqual(rootManifest.workspaces, ['packages/*']);
  const owners = new Map();
  for (const entry of readdirSync(join(checkout, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(checkout, 'packages', entry.name, 'package.json');
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file), manifest = JSON.parse(bytes);
    assert.ok(!owners.has(manifest.name), `Duplicate current owner ${manifest.name}`);
    owners.set(manifest.name, { manifest, sha256: digest(bytes) });
  }
  assert.equal(owners.size, 13, 'This acceptance snapshot must contain 13 workspace owners');
  const manifestBytes = readFileSync(join(payload, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.release, rootManifest.version);
  assert.equal(manifest.internalRuntimeClosed, true);
  assert.equal(manifest.distManifestSha256, digest(readFileSync(join(checkout, 'dist-manifest.json'))));
  assert.equal(manifest.packages.length, owners.size);
  assert.deepEqual(manifest.packages.map(p => p.name).sort(), [...owners.keys()].sort());
  assert.deepEqual(readdirSync(payload).sort(), ['manifest.json', ...manifest.packages.map(p => p.tarball)].sort());
  report.payloadManifestSha256 = digest(manifestBytes);
  report.distManifestSha256 = manifest.distManifestSha256;
  const packedOwners = new Map();
  const overrides = {};
  for (const item of manifest.packages) {
    const owner = owners.get(item.name);
    assert.equal(item.version, owner.manifest.version);
    assert.equal(item.private, owner.manifest.private === true);
    assert.equal(item.sourceManifestSha256, owner.sha256);
    assert.equal(item.tarball, `${item.name.slice('@canlang/'.length)}-${item.version}.tgz`);
    assert.match(item.tarball, /^[a-z0-9-]+-[0-9A-Za-z.+-]+\.tgz$/);
    const file = join(payload, item.tarball), bytes = readFileSync(file);
    assert.equal(item.bytes, bytes.length, `${item.name}: payload size mismatch`);
    assert.equal(item.sha256, digest(bytes), `${item.name}: payload checksum mismatch`);
    const packed = JSON.parse(command(`manifest-${item.name.slice('@canlang/'.length)}`, 'tar', ['-xOf', file, 'package/package.json'], consumer));
    assert.equal(packed.name, item.name);
    assert.equal(packed.version, item.version);
    assert.equal(packed.private, owner.manifest.private);
    const facts = {};
    for (const group of groups) {
      const internal = Object.keys(owner.manifest[group] ?? {}).filter(name => name.startsWith('@canlang/')).sort();
      assert.deepEqual(Object.keys(packed[group] ?? {}).filter(name => name.startsWith('@canlang/')).sort(), internal);
      const groupFacts = {};
      for (const dependency of internal) {
        assert.ok(owners.has(dependency), `${item.name}: missing artifact owner ${dependency}`);
        const version = owners.get(dependency).manifest.version;
        assert.equal(packed[group][dependency], version, `${item.name}: packed internal range mismatch`);
        groupFacts[dependency] = { sourceRange: owner.manifest[group][dependency], packedRange: packed[group][dependency], targetVersion: version };
      }
      if (internal.length) facts[group] = groupFacts;
    }
    assert.deepEqual(item.internalDependencies, facts, `${item.name}: recorded dependency rewrite facts mismatch`);
    packedOwners.set(item.name, packed);
    const copied = join(tarballs, item.tarball);
    copyFileSync(file, copied);
    assert.equal(digest(readFileSync(copied)), item.sha256, 'Consumer copy must equal the release artifact');
    overrides[item.name] = `file:${copied}`;
    report.packages.push({ name: item.name, version: item.version, private: item.private, tarball: file, copiedTarball: copied, bytes: item.bytes, sha256: item.sha256,
      internalDependencies: facts, internalRuntimeClosure: item.internalRuntimeClosure });
  }
  for (const item of manifest.packages) {
    const seen = new Set([item.name]);
    function visit(name) {
      const packed = packedOwners.get(name);
      for (const dependency of Object.keys({ ...packed.dependencies, ...packed.optionalDependencies, ...packed.peerDependencies })) {
        if (!dependency.startsWith('@canlang/')) continue;
        assert.ok(packedOwners.has(dependency), `${name}: release runtime closure is incomplete`);
        if (!seen.has(dependency)) { seen.add(dependency); visit(dependency); }
      }
    }
    visit(item.name); seen.delete(item.name);
    assert.deepEqual(item.internalRuntimeClosure, [...seen].sort(), `${item.name}: recorded runtime closure differs from its tarballs`);
  }
  save(join(consumer, 'package.json'), { name: 'canlang-exact-release-artifact-consumer', private: true, type: 'module',
    dependencies: { '@canlang/cloudflare': overrides['@canlang/cloudflare'] }, overrides });
  writeFileSync(join(consumer, 'bunfig.toml'), '[install]\nlinker = "isolated"\n');
  save(join(scratch, 'release-payload.json'), { payloadManifestSha256: report.payloadManifestSha256, packages: report.packages });
  command('isolated-install', 'bun', ['install', '--ignore-scripts'], consumer);
  const verifier = join(consumer, 'verify.mjs');
  copyFileSync(join(checkout, 'scripts/verify-installed-worker.mjs'), verifier);
  report.verifierSha256 = digest(readFileSync(verifier));
  command('installed-worker', process.execPath, ['--permission', `--allow-fs-read=${scratch}`, `--allow-fs-write=${scratch}`,
    '--allow-child-process', verifier, '--consumer', checkout], consumer);
  report.worker = json(join(consumer, 'evidence.json'));
  assert.equal(report.worker.linker, 'isolated');
  assert.deepEqual(report.worker.directDependencies, ['@canlang/cloudflare']);
  assert.deepEqual(report.worker.directPackageBindings, ['cloudflare']);
  assert.equal(report.worker.checkoutRead, 'ERR_ACCESS_DENIED');
  report.status = 'success';
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  save(join(scratch, 'report.json'), report);
  save(join(evidenceDirectory, 'artifact-consumer-probe.result.json'), report);
  console.log(`Exact release artifact consumer ${report.status}. Preserved scratch/logs: ${scratch}`);
  if (report.error) console.error(report.error);
}
