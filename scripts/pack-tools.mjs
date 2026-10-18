#!/usr/bin/env node
/** Assemble an offline Linux tool release from the existing frozen dependency
 * install and validated package artifacts. This does not build or publish. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packRelease } from './pack-release.mjs';
import { nativeArtifact } from './distribution/native-artifact.mjs';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--compiler', '--dev-server', '--node', '--bun', '--node-license', '--bun-license', '--output'].includes(process.argv[i]), `Unknown option ${process.argv[i]}`);
  assert.ok(process.argv[i + 1], `Missing value for ${process.argv[i]}`);
  args.set(process.argv[i], resolve(process.argv[i + 1]));
}
assert.equal(process.platform, 'linux', 'Build this archive on native Linux');
assert.equal(process.arch, 'x64', 'This artifact supports Linux x86_64 only');
const compiler = args.get('--compiler') ?? join(root, 'compiler/target/release/can');
const devServer = args.get('--dev-server') ?? join(root, 'compiler/target/release/can-dev');
const node = args.get('--node') ?? process.execPath;
const bun = args.get('--bun') ?? execFileSync('which', ['bun'], { encoding: 'utf8' }).trim();
const nodeLicense = args.get('--node-license') ?? join(dirname(dirname(realpathSync(node))), 'LICENSE');
const bunLicense = args.get('--bun-license');
assert.ok(bunLicense && existsSync(bunLicense), 'Pass --bun-license with LICENSE.md from the selected Bun release');
assert.ok(existsSync(nodeLicense), 'Pass --node-license with the selected Node distribution LICENSE');
const versions = {
  compiler: execFileSync(compiler, ['--version'], { encoding: 'utf8' }).trim(),
  devServer: nativeArtifact(devServer, 'can-dev', json(join(root, 'package.json')).version, 'linux-x64').version,
  node: execFileSync(node, ['--version'], { encoding: 'utf8' }).trim(),
  bun: execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim(),
};
assert.match(versions.node, /^v24\./, 'Selected tool release requires Node 24; tools.json pins the exact version');
assert.equal(versions.bun, '1.4.2', 'Selected tool release pins Bun 1.4.2');
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceChanges = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(sourceChanges, '', 'Commit source changes before packaging a Soda tool archive');
// Timestamp normalization must never conceal genuinely stale producer bytes.
// Reuse the preview owner's existing source/compiler currency checks first.
const currency = await import(new URL('../packages/cloudflare/dist/dev/preview-inputs.js', import.meta.url));
const priorToolRoot = process.env.CAN_TOOL_ROOT;
try {
  delete process.env.CAN_TOOL_ROOT;
  currency.installedOwnedSourceInputs(root);
  currency.compilerSourceInputs(root, compiler);
} finally {
  if (priorToolRoot !== undefined) process.env.CAN_TOOL_ROOT = priorToolRoot;
}
const release = packRelease();
const output = args.get('--output') ?? join(root, 'output', 'tools');
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(output, '.pack-tools-'));
const destination = join(scratch, 'canlang');
mkdirSync(destination);
try {
  const packages = new Map(), defaults = new Map();
  function findPackage(specifier, from) {
    const require = createRequire(join(from, 'package.json'));
    // Native resource owners such as libvips expose only subpaths. Their
    // actual installed manifest is still discoverable through Node's module
    // search locations; they must not disappear from the offline closure.
    for (const modules of require.resolve.paths(specifier) ?? []) {
      const directory = join(modules, specifier);
      const manifest = join(directory, 'package.json');
      if (existsSync(manifest) && json(manifest).name === specifier) return realpathSync(directory);
    }
    let entry;
    try { entry = require.resolve(`${specifier}/package.json`); }
    catch { entry = require.resolve(specifier); }
    let directory = dirname(realpathSync(entry));
    while (!existsSync(join(directory, 'package.json')) || json(join(directory, 'package.json')).name !== specifier) {
      const parent = dirname(directory);
      assert.notEqual(parent, directory, `No package owner for ${specifier}`);
      directory = parent;
    }
    return directory;
  }
  function discover(directory) {
    directory = realpathSync(directory);
    if (packages.has(directory)) return packages.get(directory);
    const manifest = json(join(directory, 'package.json'));
    const pkg = { directory, manifest, dependencies: [] };
    packages.set(directory, pkg);
    if (!defaults.has(manifest.name)) defaults.set(manifest.name, pkg);
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) {
      let dependency;
      try { dependency = findPackage(name, directory); }
      catch (error) {
        if (name in (manifest.optionalDependencies ?? {}) && error.code === 'MODULE_NOT_FOUND') continue;
        throw error;
      }
      pkg.dependencies.push(discover(dependency));
    }
    return pkg;
  }
  discover(join(root, 'packages/cloudflare'));
  discover(join(root, 'packages/testkit'));
  const nodeModules = join(destination, 'lib/node_modules');
  mkdirSync(nodeModules, { recursive: true });
  const installed = new Set();
  function copyPackage(pkg, target, ancestors = new Set()) {
    if (installed.has(target)) return;
    assert.ok(!ancestors.has(pkg.directory), `Conflicting cyclic dependency for ${pkg.manifest.name}`);
    installed.add(target);
    mkdirSync(target, { recursive: true });
    if (pkg.manifest.name.startsWith('@canlang/')) {
      const artifact = release.packages.find(item => item.name === pkg.manifest.name);
      assert.ok(artifact, `No owning release artifact for ${pkg.manifest.name}`);
      execFileSync('tar', ['-xzf', join(root, 'output/release-artifacts', artifact.tarball), '--strip-components=1', '-C', target]);
      // References are delivered assets. They preserve the existing preview
      // source/currency checks without requiring a checkout or toolchain.
      for (const entry of ['src', 'scripts', 'semantics/src', 'bindings/src', 'bindings/generated', 'conformance/v1', 'Cargo.toml', 'Cargo.lock', 'themes.css']) {
        const source = join(pkg.directory, entry);
        if (existsSync(source)) cpSync(source, join(target, entry), { recursive: true, dereference: true });
      }
    } else {
      cpSync(pkg.directory, target, { recursive: true, dereference: true,
        filter: path => basename(path) !== 'node_modules' });
    }
    const next = new Set([...ancestors, pkg.directory]);
    for (const dependency of pkg.dependencies) {
      if (defaults.get(dependency.manifest.name).manifest.version !== dependency.manifest.version) {
        copyPackage(dependency, join(target, 'node_modules', dependency.manifest.name), next);
      }
    }
  }
  for (const pkg of defaults.values()) copyPackage(pkg, join(nodeModules, pkg.manifest.name));
  versions.miniflare = defaults.get('miniflare').manifest.version;
  versions.workerd = defaults.get('workerd').manifest.version;
  assert.equal(versions.miniflare, '4.20260730.0');
  assert.equal(versions.workerd, '1.20260730.1');
  for (const entry of ['package.json', 'compiler/src', 'compiler/Cargo.toml', 'compiler/Cargo.lock', 'docs/specification', 'docs/design/UI-COMPONENTS.md']) {
    mkdirSync(dirname(join(destination, entry)), { recursive: true });
    cpSync(join(root, entry), join(destination, entry), { recursive: true, dereference: true });
  }
  // Version checks consume the existing package-owner manifests without another workspace copy.
  for (const entry of readdirSync(join(root, 'packages'))) {
    const manifest = join(root, 'packages', entry, 'package.json');
    if (!existsSync(manifest)) continue;
    mkdirSync(join(destination, 'packages', entry), { recursive: true });
    copyFileSync(manifest, join(destination, 'packages', entry, 'package.json'));
  }
  // Exercise the owning help loader against delivered references, including
  // linked source headings. A document copied alone is not an offline closure.
  const { loadConstructHelpIndex } = await import(new URL('../packages/cloudflare/dist/dev/construct-help.js', import.meta.url));
  const { CATALOG } = await import(new URL('../packages/values/dist/src/catalog.js', import.meta.url));
  const { UI_CATALOG } = await import(new URL('../packages/ui/dist/src/catalog.js', import.meta.url));
  await loadConstructHelpIndex(destination, {
    languageVersion: '1.0', compiler: { sha256: sha256(readFileSync(compiler)) },
    grammar: { sha256: sha256(readFileSync(join(destination, 'docs/specification/GRAMMAR.md'))) },
    values: { sha256: sha256(readFileSync(join(nodeModules, '@canlang/values/src/catalog.ts'))), entries: CATALOG.entries },
    ui: { sha256: sha256(readFileSync(join(nodeModules, '@canlang/ui/src/catalog.ts'))), entries: UI_CATALOG.entries },
  }, sha256(readFileSync(join(destination, 'docs/specification/CONSTRUCT-HELP.md'))));
  for (const [source, target] of [[compiler, 'compiler/target/release/can'], [devServer, 'libexec/can-dev'], [node, 'libexec/node'], [bun, 'libexec/bun']]) {
    mkdirSync(dirname(join(destination, target)), { recursive: true });
    copyFileSync(realpathSync(source), join(destination, target));
    chmodSync(join(destination, target), 0o755);
  }
  mkdirSync(join(destination, 'licenses'));
  copyFileSync(join(root, 'LICENSE'), join(destination, 'licenses/Canlang-LICENSE'));
  copyFileSync(nodeLicense, join(destination, 'licenses/Node-LICENSE'));
  copyFileSync(bunLicense, join(destination, 'licenses/Bun-LICENSE.md'));
  execFileSync('python3', [join(root, 'scripts/check-compiler-release-notices.py'), '--target', 'x86_64-unknown-linux-gnu', '--output-dir', join(destination, 'licenses/compiler')], { stdio: 'inherit' });
  execFileSync('python3', [join(root, 'scripts/check-dev-server-release-notices.py'), '--target', 'x86_64-unknown-linux-gnu', '--output-dir', join(destination, 'licenses/dev-server')], { stdio: 'inherit' });
  const shared = '#!/bin/sh\nset -eu\nCAN_TOOL_ENTRY=$(readlink -f -- "$0")\nCAN_TOOL_ROOT=$(CDPATH= cd -- "$(dirname -- "$CAN_TOOL_ENTRY")/.." && pwd -P)\nexport CAN_TOOL_ROOT\nexport PATH="$CAN_TOOL_ROOT/bin:$PATH"\nexport NODE_PATH="$CAN_TOOL_ROOT/lib/node_modules${NODE_PATH:+:$NODE_PATH}"\nexport CAN_CATALOG="${CAN_CATALOG:-$CAN_TOOL_ROOT/lib/node_modules/@canlang/cloudflare/dist/native-catalog.json}"\nexport CAN_DEV_COMPILER="${CAN_DEV_COMPILER:-$CAN_TOOL_ROOT/compiler/target/release/can}"\nexport CAN_COMPILER_BIN="${CAN_COMPILER_BIN:-$CAN_TOOL_ROOT/compiler/target/release/can}"\nexport CAN_DEV_HELP_INDEX="${CAN_DEV_HELP_INDEX:-$CAN_TOOL_ROOT/docs/specification/CONSTRUCT-HELP.md}"\nexport CAN_HELP_INDEX="${CAN_HELP_INDEX:-$CAN_TOOL_ROOT/docs/specification/CONSTRUCT-HELP.md}"\nexport CAN_PLATFORM_BIN="$CAN_TOOL_ROOT/bin/can-platform"\nexport CAN_DEV_BIN="$CAN_TOOL_ROOT/bin/can-dev"\n';
  const commands = [['can', 'exec "$CAN_TOOL_ROOT/compiler/target/release/can" "$@"'], ['can-dev', 'exec "$CAN_TOOL_ROOT/libexec/can-dev" "$@"']];
  const nativeDev = 'export CAN_DEV_NODE="${CAN_DEV_NODE:-$CAN_TOOL_ROOT/libexec/node}"\nexport CAN_DEV_RUNTIME_HOST="${CAN_DEV_RUNTIME_HOST:-$CAN_TOOL_ROOT/lib/node_modules/@canlang/cloudflare/dist/dev/runtime-host.js}"\n';
  const temporaryFiles = 'if [ -z "${TMPDIR:-}" ]; then\n  export TMPDIR="$HOME/.cache/canlang/tmp"\n  mkdir -p -m 700 -- "$TMPDIR"\nfi\n';
  mkdirSync(join(destination, 'bin'));
  for (const name of ['node', 'bun']) {
    writeFileSync(join(destination, 'bin', name), '#!/bin/sh\nset -eu\nCAN_TOOL_ENTRY=$(readlink -f -- "$0")\nCAN_TOOL_ROOT=$(CDPATH= cd -- "$(dirname -- "$CAN_TOOL_ENTRY")/.." && pwd -P)\n' +
      `exec "$CAN_TOOL_ROOT/libexec/${name}" "$@"\n`, { mode: 0o755 });
  }
  for (const [name, entry] of Object.entries(defaults.get('@canlang/cloudflare').manifest.bin)) {
    assert.match(name, /^can-[a-z-]+$/, 'Unexpected Canlang executable name');
    assert.match(entry, /^\.\/dist\/[a-zA-Z0-9_/-]+\.js$/, 'Executable must belong to the Cloudflare distribution');
    assert.ok(!entry.includes('/../'), 'Executable must not escape its distribution');
    commands.push([name, `exec "$CAN_TOOL_ROOT/bin/node" "$CAN_TOOL_ROOT/lib/node_modules/@canlang/cloudflare/${entry.slice(2)}" "$@"`]);
  }
  for (const [name, command] of commands) {
    writeFileSync(join(destination, 'bin', name), shared + nativeDev + temporaryFiles + command + '\n', { mode: 0o755 });
  }
  const licenses = [...packages.values()].map(pkg => ({ name: pkg.manifest.name, version: pkg.manifest.version,
    license: pkg.manifest.license ?? 'UNSPECIFIED', files: readdirSync(pkg.directory).filter(name => /license|notice|copying/i.test(name)) }));
  const files = [];
  const epoch = new Date(Number(execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()) * 1000);
  function inventory(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      assert.ok(!lstatSync(path).isSymbolicLink(), `Tool archive cannot contain links: ${path}`);
      if (entry.isDirectory()) {
        chmodSync(path, 0o755);
        inventory(path);
      }
      else {
        assert.ok(entry.isFile(), `Tool archive cannot contain special files: ${path}`);
        chmodSync(path, statSync(path).mode & 0o111 ? 0o755 : 0o644);
        const bytes = readFileSync(path);
        files.push({ path: relative(destination, path), sha256: sha256(bytes), bytes: bytes.length, mode: statSync(path).mode & 0o777 });
      }
      // Release artifacts share a fixed timestamp; future local edits still
      // trip the existing source/output freshness checks.
      utimesSync(path, epoch, epoch);
    }
  }
  inventory(destination);
  const manifest = { schema: 'canlang.tools.v1', platform: 'linux-x86_64', sourceRevision, dirty: sourceChanges.length > 0, sourceChanges,
    versions, packages: licenses, files, scope: 'Offline authoring, portable assembly and local workerd; browser binaries and production qualification excluded.' };
  chmodSync(destination, 0o755);
  writeFileSync(join(destination, 'tools.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
  const filename = 'canlang-tools-linux-x86_64.tar.gz';
  execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', `--mtime=@${epoch.getTime() / 1000}`, '-czf', join(output, filename), '-C', scratch, 'canlang']);
  const archive = readFileSync(join(output, filename));
  writeFileSync(join(output, 'canlang-release.json'), JSON.stringify({ sourceRevision, archiveFilename: filename, sha256: sha256(archive), versions }, null, 2) + '\n');
  console.log(`Offline tool archive: ${join(output, filename)} (${archive.length} bytes)`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
