#!/usr/bin/env node
/** Pack the complete workspace artifact set after release validation, without lifecycle builds. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskEnvironment } from './run-tasks.mjs';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const dependencyGroups = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];
const inside = (directory, file) => {
  const rel = relative(directory, file);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};

export function packRelease() {
  const environment = taskEnvironment();
  const rootManifest = json(join(root, 'package.json'));
  assert.deepEqual(rootManifest.workspaces, ['packages/*'], 'Update artifact discovery when the declared workspace pattern changes');
  const owners = new Map();
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, 'packages', entry.name);
    if (!existsSync(join(directory, 'package.json'))) continue;
    const manifest = json(join(directory, 'package.json'));
    assert.match(manifest.name, /^@canlang\/[a-z0-9-]+$/, 'Expected an owning Can workspace name');
    assert.match(manifest.version, /^[0-9A-Za-z.+-]+$/, 'Expected a filename-safe package version');
    assert.ok(!owners.has(manifest.name), `Duplicate workspace owner: ${manifest.name}`);
    assert.ok(statSync(join(directory, 'dist')).isDirectory(), `${manifest.name}: distribution is missing`);
    owners.set(manifest.name, { directory, manifest, directoryName: entry.name });
  }
  assert.ok(owners.size > 0, 'No declared workspace packages found');
  // Direct invocation must also reject stale release facts. Neither validation runs a build.
  for (const command of ['stamp.js', 'manifest.js']) {
    execFileSync(process.execPath, [join(root, 'packages/cloudflare/dist/release', command), ...(command === 'manifest.js' ? ['--verify'] : [])],
      { cwd: root, env: environment, stdio: 'inherit' });
  }
  const distManifestBytes = readFileSync(join(root, 'dist-manifest.json'));
  const distManifest = JSON.parse(distManifestBytes);
  assert.deepEqual([...distManifest.roots].sort(), [...owners.values()].map(owner => `packages/${owner.directoryName}/dist`).sort(), 'Release manifest must cover every declared workspace distribution');
  for (const [name, owner] of owners) {
    for (const group of dependencyGroups) {
      for (const dependency of Object.keys(owner.manifest[group] ?? {})) {
        if (dependency.startsWith('@canlang/')) assert.ok(owners.has(dependency), `${name}: artifact owner missing for ${dependency}`);
      }
    }
  }
  const runtimeClosure = name => {
    const seen = new Set([name]);
    function visit(current) {
      const manifest = owners.get(current).manifest;
      for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
        if (!owners.has(dependency) || seen.has(dependency)) continue;
        seen.add(dependency); visit(dependency);
      }
    }
    visit(name); seen.delete(name);
    return [...seen].sort();
  };
  const output = join(root, 'output');
  mkdirSync(output, { recursive: true });
  assert.ok(inside(root, realpathSync(output)), 'Release output directory must stay inside the checkout');
  const destination = join(output, 'release-artifacts');
  if (existsSync(destination)) assert.ok(!lstatSync(destination).isSymbolicLink(), 'Refusing to replace a linked release artifact directory');
  const stage = mkdtempSync(join(output, '.release-artifacts-'));
  try {
    const packages = [];
    for (const [name, owner] of owners) {
      const filename = `${name.slice('@canlang/'.length)}-${owner.manifest.version}.tgz`;
      const tarball = join(stage, filename);
      execFileSync('bun', ['pm', 'pack', '--ignore-scripts', '--filename', tarball, '--quiet'], { cwd: owner.directory, env: environment, stdio: 'pipe' });
      const packed = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
      assert.equal(packed.name, name, `${name}: packed owner mismatch`);
      assert.equal(packed.version, owner.manifest.version, `${name}: packed version mismatch`);
      assert.equal(packed.private, owner.manifest.private, `${name}: private flag changed while packing`);
      const internalDependencies = {};
      for (const group of dependencyGroups) {
        const facts = {};
        for (const [dependency, sourceRange] of Object.entries(owner.manifest[group] ?? {})) {
          if (!owners.has(dependency)) continue;
          const targetVersion = owners.get(dependency).manifest.version;
          const packedRange = packed[group]?.[dependency];
          assert.equal(packedRange, targetVersion, `${name}: ${group} ${dependency} must pack its owning version`);
          facts[dependency] = { sourceRange, packedRange, targetVersion };
        }
        if (Object.keys(facts).length) internalDependencies[group] = facts;
      }
      const bytes = readFileSync(tarball);
      packages.push({ name, version: packed.version, private: packed.private === true, tarball: filename, sha256: digest(bytes), bytes: bytes.length,
        sourceManifestSha256: digest(readFileSync(join(owner.directory, 'package.json'))), internalDependencies, internalRuntimeClosure: runtimeClosure(name) });
    }
    const manifest = { version: 1, release: rootManifest.version, distManifestSha256: digest(distManifestBytes),
      scope: 'Complete workspace tarball artifacts, including private owners; no registry publication or native release/adoption qualification.',
      internalRuntimeClosed: true, packages };
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    // Only this dedicated artifact directory is replaced; previous unrelated output remains intact.
    rmSync(destination, { recursive: true, force: true });
    renameSync(stage, destination);
    console.log(`Packed ${packages.length} workspace artifacts with complete internal runtime closure: ${destination}`);
    return manifest;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { packRelease(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
