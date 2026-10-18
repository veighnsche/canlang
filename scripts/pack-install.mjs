#!/usr/bin/env node
/** Assemble a self-contained host release from frozen, built production outputs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packBrowserDevelopmentTools } from './distribution/browser-tools.mjs';
import { nativeArtifact } from './distribution/native-artifact.mjs';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--compiler', '--dev-server', '--node', '--tools', '--out', '--dist-snapshot'].includes(process.argv[i]) && process.argv[i + 1], 'Usage: node scripts/pack-install.mjs [--compiler FILE] [--dev-server FILE] [--node FILE] [--tools DIR] [--out DIR]');
  options.set(process.argv[i], resolve(process.argv[i + 1]));
}
const platform = `${process.platform}-${process.arch}`;
assert.ok(['darwin-arm64', 'linux-x64'].includes(platform), `Unqualified release host: ${platform}`);
const version = json(join(root, 'package.json')).version;
const out = options.get('--out') ?? join(root, 'output/install');
assert.ok(relative(root, out).startsWith('output/'), 'Owned installation output must be under checkout/output/');
const stage = join(out, 'can');
assert.ok(!existsSync(stage), `Remove or move the previous owned stage first: ${stage}`);
mkdirSync(stage, { recursive: true });
const files = new Map();
function copy(source, destination, group, predicate = () => true, ancestors = new Set()) {
  const actual = realpathSync(source), info = statSync(actual);
  if (info.isDirectory()) {
    if (ancestors.has(actual)) return; // Bun package self-aliases carry no additional files.
    const next = new Set([...ancestors, actual]);
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(actual).sort()) {
      const rel = relative(source, join(source, entry));
      if (predicate(entry, join(source, entry), rel)) copy(join(source, entry), join(destination, entry), group, predicate, next);
    }
  } else if (info.isFile()) {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(actual, destination);
    chmodSync(destination, info.mode & 0o777);
    files.set(relative(stage, destination), { group, bytes: info.size });
  } else throw new Error(`Unsupported release file: ${source}`);
}
function write(path, contents, group, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents); chmodSync(path, mode);
  files.set(relative(stage, path), { group, bytes: Buffer.byteLength(contents) });
}
const excluded = new Set(['node_modules', '.git', '.bin', '__tests__', '__snapshots__', 'coverage', 'CHANGELOG.md']);
const retiredDevEntries = new Set(['control-cli.js', 'control-client.js', 'session-core.js', 'session-service.js',
  'session-socket.js', 'session-daemon.js', 'session-daemon-entry.js', 'terminal.js', 'terminal-presenter.js']);
function productionFile(name, path) {
  if (excluded.has(name)) return false;
  if (path.includes('/cloudflare/dist/dev/') && retiredDevEntries.has(name)) return false;
  if (/^README(?:\.md)?$/i.test(name) && !/license|copyright|notice/i.test(readFileSync(path, 'utf8'))) return false;
  // Postinstall duplicates the host optional-package executable; runtime resolves that owner directly.
  if (/[/]csv-parse[/]dist[/](?:umd|iife)$/.test(path)) return false;
  if (path.endsWith('/workerd/bin/workerd') || path.endsWith('/wrangler/wrangler-dist/metafile-cjs.json')) return false;
  if (/\.(?:test|spec)\.[cm]?js$/.test(name) || name.endsWith('.tsbuildinfo')) return false;
  // Values BUILD.json verifies the generated declaration bytes as well as WASM/glue.
  if (/\.(?:map|ts|tsx)$/.test(name) && !path.includes('/bindings/generated/') && !path.includes('/wrangler/templates/')) return false;
  return true;
}
copy(join(root, 'scripts/distribution/module-resolution.mjs'), join(stage, 'libexec/module-resolution.mjs'), 'launchers');
const compiler = options.get('--compiler') ?? join(root, 'compiler/target/release/can');
const devServer = options.get('--dev-server') ?? join(root, 'compiler/target/release/can-dev');
copy(compiler, join(stage, 'libexec/can'), 'compiler');
copy(devServer, join(stage, 'libexec/can-dev'), 'dev-server');
const nativeArtifacts = {
  compiler: nativeArtifact(join(stage, 'libexec/can'), 'can', version, platform),
  devServer: nativeArtifact(join(stage, 'libexec/can-dev'), 'can-dev', version, platform),
};
const node = options.get('--node') ?? process.execPath;
assert.match(execFileSync(node, ['--version'], { encoding: 'utf8' }).trim(), /^v24\./, 'Release host runtime must use verified Node24');
copy(node, join(stage, 'libexec/node'), 'node');
copy(join(dirname(dirname(node)), 'LICENSE'), join(stage, 'licenses/node-LICENSE'), 'licenses');
copy(join(root, 'LICENSE'), join(stage, 'LICENSE'), 'licenses');
copy(join(root, 'scripts/distribution/licenses'), join(stage, 'licenses'), 'licenses');
assert.ok(existsSync(join(dirname(compiler), 'THIRD-PARTY-NOTICES.txt')), 'Run scripts/check-compiler-release-notices.py for the host release first');
copy(join(dirname(compiler), 'THIRD-PARTY-NOTICES.txt'), join(stage, 'licenses/compiler-THIRD-PARTY-NOTICES.txt'), 'licenses');
copy(join(dirname(devServer), 'DEV-SERVER-THIRD-PARTY-NOTICES.txt'), join(stage, 'licenses/dev-server-THIRD-PARTY-NOTICES.txt'), 'licenses');

const owners = new Map(readdirSync(join(root, 'packages')).filter(name => existsSync(join(root, 'packages', name, 'package.json')))
  .map(name => { const directory = join(root, 'packages', name); return [json(join(directory, 'package.json')).name, directory]; }));
const packages = new Map(), queue = [];
function packageDirectory(name, from) {
  if (owners.has(name)) return owners.get(name);
  const require = createRequire(join(from, 'package.json'));
  // Locate by Node's search paths, not exported entrypoints (which may have nested package.json files).
  for (const search of require.resolve.paths(name) ?? []) {
    const candidate = join(search, name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
  }
  throw Object.assign(new Error(`Missing production dependency ${name} from ${from}`), { code: 'MODULE_NOT_FOUND' });
}
const externalRoot = options.get('--tools') ?? join(root, 'output/install-tools');
function register(name, from) {
  const source = packageDirectory(name, from), manifest = json(join(source, 'package.json'));
  const admits = (values, value) => !values || ((!values.some(item => !item.startsWith('!')) || values.includes(value)) && !values.includes('!' + value));
  const libc = process.platform === 'linux' && process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl';
  if (!admits(manifest.os, process.platform) || !admits(manifest.cpu, process.arch) || !admits(manifest.libc, libc)) throw Object.assign(new Error(`Incompatible package ${name}`), { code: 'INCOMPATIBLE_HOST' });
  assert.equal(manifest.name, name);
  const id = `${name}@${manifest.version}`;
  let pkg = packages.get(id);
  if (!pkg) { pkg = { id, name, source, manifest, dependencies: new Map(), destinations: [] }; packages.set(id, pkg); queue.push(pkg); }
  return pkg;
}
const roots = ['@canlang/cloudflare', '@canlang/testkit'].map(name => register(name, root));
roots.push(register('wrangler', externalRoot));
for (let index = 0; index < queue.length; index++) {
  const pkg = queue[index];
  const required = Object.keys(pkg.manifest.dependencies ?? {});
  const optional = Object.keys(pkg.manifest.optionalDependencies ?? {});
  const peers = Object.keys(pkg.manifest.peerDependencies ?? {}).filter(name => !pkg.manifest.peerDependenciesMeta?.[name]?.optional);
  for (const name of new Set([...required, ...optional, ...peers])) {
    try {
      const child = register(name, pkg.source);
            pkg.dependencies.set(name, child);
    } catch (error) {
      if (optional.includes(name) && ['MODULE_NOT_FOUND', 'INCOMPATIBLE_HOST'].includes(error.code)) continue;
      throw error;
    }
  }
}
// One physical top-level package per name. Only version conflicts get nested copies.
const top = new Map();
for (const pkg of [...roots, ...packages.values()]) if (!top.has(pkg.name)) top.set(pkg.name, pkg);
const installed = new Set();
function install(pkg, destination, available, ancestry = new Set()) {
  if (installed.has(destination)) return;
  assert.ok(!ancestry.has(pkg.id), `Unresolvable nested dependency cycle: ${pkg.id}`);
  installed.add(destination); pkg.destinations.push(relative(stage, destination));
  if (pkg.name.startsWith('@canlang/')) {
    copy(join(options.get('--dist-snapshot') ?? join(root, 'packages'), pkg.name.slice('@canlang/'.length), 'dist'), join(destination, 'dist'), 'can-runtime', (name, path) => !['test', 'tests'].includes(name) && productionFile(name, path));
    for (const item of pkg.manifest.files ?? []) {
      const name = item.replace(/\/$/, '');
      if (name !== 'dist' && existsSync(join(pkg.source, name))) copy(join(pkg.source, name), join(destination, name), 'can-runtime', productionFile);
    }
    for (const name of readdirSync(pkg.source).filter(name => /^(?:LICENSE|NOTICE|COPYING)/i.test(name))) copy(join(pkg.source, name), join(destination, name), 'licenses');
  } else copy(pkg.source, destination, 'dependencies', productionFile);
  const { devDependencies, scripts, ...manifest } = pkg.manifest;
  write(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', pkg.name.startsWith('@canlang/') ? 'can-runtime' : 'dependencies');
  const next = new Set([...ancestry, pkg.id]);
  const local = new Map(available);
  for (const [name, child] of pkg.dependencies) if (available.get(name)?.id !== child.id) local.set(name, child);
  for (const [name, child] of pkg.dependencies) {
    if (available.get(name)?.id !== child.id) install(child, join(destination, 'node_modules', name), local, next);
  }
}
for (const pkg of top.values()) install(pkg, join(stage, 'node_modules', pkg.name), top);
// Remove only local symbol/debug tables from owned copies. Keep dynamic exports
// needed by native addons, then re-sign modified Mach-O executables for arm64.
const binaryOptimizations = [];
for (const path of [...files.keys()].filter(path => path === 'libexec/node' || /[/]@cloudflare[/]workerd-[^/]+[/]bin[/]workerd$/.test(path))) {
  const destination = join(stage, path), beforeBytes = statSync(destination).size;
  if (process.platform === 'darwin') {
    execFileSync('xcrun', ['strip', '-x', destination], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('codesign', ['--force', '--sign', '-', destination], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('codesign', ['--verify', destination]);
  } else {
    execFileSync('strip', ['--strip-debug', destination]);
  }
  const afterBytes = statSync(destination).size;
  files.get(path).bytes = afterBytes;
  execFileSync(destination, ['--version']);
  binaryOptimizations.push({ path, beforeBytes, afterBytes,
    method: process.platform === 'darwin' ? 'strip -x; ad-hoc codesign' : 'strip --strip-debug' });
}
for (const pkg of packages.values()) for (const destination of pkg.destinations) {
  const require = createRequire(join(stage, destination, 'package.json'));
  for (const [name, expected] of pkg.dependencies) {
    const candidate = require.resolve.paths(name).map(search => join(search, name, 'package.json')).find(existsSync);
    assert.ok(candidate, `${pkg.id}: installed dependency ${name} is absent`);
    assert.equal(json(candidate).version, expected.manifest.version, `${pkg.id}: installed ${name} version differs`);
  }
}
execFileSync(join(stage, 'libexec/node'), ['--input-type=module', '-e', "await import('@canlang/cloudflare'); await import('@canlang/testkit')"], { cwd: stage, stdio: 'inherit' });
assert.ok(existsSync(join(stage, 'node_modules/@canlang/cloudflare/dist/dev/runtime-host.js')), 'Native runtime bridge is missing');


// Existing release stamp ownership facts, without shipping development declarations.
write(join(stage, 'package.json'), JSON.stringify({ name: 'can-install', version, private: true, type: 'module' }) + '\n', 'metadata');
write(join(stage, 'compiler/Cargo.toml'), `[package]\nname = \"canlang-compiler\"\nversion = \"${version}\"\n`, 'metadata');
for (const [name, directory] of owners) write(join(stage, 'packages', basename(directory), 'package.json'), JSON.stringify({ name, version: json(join(directory, 'package.json')).version }) + '\n', 'metadata');
for (const name of ['values', 'ui']) copy(join(root, 'packages', name, 'src/catalog.ts'), join(stage, 'packages', name, 'src/catalog.ts'), 'catalog');
for (const name of ['GRAMMAR.md', 'CONSTRUCT-HELP.md']) copy(join(root, 'docs/specification', name), join(stage, 'docs/specification', name), 'catalog');
const helpDocument = join(root, 'docs/specification/CONSTRUCT-HELP.md');
const references = new Set([...readFileSync(helpDocument, 'utf8').matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)].map(match => match[1]));
for (const reference of references) {
  const source = resolve(dirname(helpDocument), reference);
  assert.ok(!relative(root, source).startsWith('..'), `Help reference escapes release owners: ${reference}`);
  copy(source, join(stage, relative(root, source)), 'catalog');
}


const launch = `#!/bin/sh
set -eu
# Resolve the user-facing install symlinks before selecting private components.
entry=$0
while [ -L "$entry" ]; do
 parent=$(CDPATH= cd -P -- "$(dirname -- "$entry")" && pwd)
 link=$(readlink "$entry")
 case "$link" in /*) entry=$link ;; *) entry=$parent/$link ;; esac
done
CAN_INSTALL_ROOT=$(CDPATH= cd -P -- "$(dirname -- "$entry")/.." && pwd)
export CAN_INSTALL_ROOT
PATH="$CAN_INSTALL_ROOT/libexec:$CAN_INSTALL_ROOT/bin:$PATH"
export PATH
CAN_CATALOG=\${CAN_CATALOG:-"$CAN_INSTALL_ROOT/node_modules/@canlang/values/dist/catalog.json"}
CAN_PLATFORM_BIN=\${CAN_PLATFORM_BIN:-"$CAN_INSTALL_ROOT/libexec/can-platform"}
CAN_DEV_BIN=\${CAN_DEV_BIN:-"$CAN_INSTALL_ROOT/libexec/can-dev"}
CAN_COMPILER_BIN=\${CAN_COMPILER_BIN:-"$CAN_INSTALL_ROOT/libexec/can"}
CAN_DEV_COMPILER=\${CAN_DEV_COMPILER:-"$CAN_INSTALL_ROOT/libexec/can"}
CAN_HELP_INDEX=\${CAN_HELP_INDEX:-"$CAN_INSTALL_ROOT/docs/specification/CONSTRUCT-HELP.md"}
export CAN_CATALOG CAN_PLATFORM_BIN CAN_DEV_BIN CAN_COMPILER_BIN CAN_DEV_COMPILER CAN_HELP_INDEX
exec "$CAN_INSTALL_ROOT/libexec/can" "$@"
`;
write(join(stage, 'bin/can'), launch, 'launchers', 0o755);
for (const [name, entry] of [['can-platform', 'node_modules/@canlang/cloudflare/dist/cli/platform.js'], ['can-soda', 'node_modules/@canlang/cloudflare/dist/cli/soda.js'], ['wrangler', 'node_modules/wrangler/bin/wrangler.js']]) {
  write(join(stage, 'libexec', name), `#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -P -- "$(dirname -- "$0")/.." && pwd)\nexec "$root/libexec/node" "$root/${entry}" "$@"\n`, 'launchers', 0o755);
}
const components = {};
for (const { group, bytes } of files.values()) components[group] = (components[group] ?? 0) + bytes;
const forbidden = new Set(['@playwright/test', 'playwright', 'playwright-core', 'typescript', 'turbo', 'vitest', 'happy-dom']);
for (const pkg of packages.values()) { assert.ok(!forbidden.has(pkg.name), `Development-only package leaked into production: ${pkg.name}`); for (const destination of pkg.destinations) assert.ok(!('devDependencies' in json(join(stage, destination, 'package.json'))), `Development metadata leaked: ${pkg.id}`); }
assert.ok(!existsSync(join(stage, 'libexec/bun')), 'Production install must use one JavaScript host runtime');
assert.ok(!existsSync(join(stage, 'browsers')), 'Production install must not contain browsers');
const manifest = { kind: 'can-install', version, platform, scope: 'Compiler, authoring, local Worker preview, inline examples and Cloudflare CLI. Browser development tools are separately installed; no Chrome, ffmpeg or Playwright is shipped.',
  inputMode: options.has('--dist-snapshot') ? 'frozen-production-outputs' : 'built-checkout',
  compilerVersion: nativeArtifacts.compiler.version, devServerVersion: nativeArtifacts.devServer.version, nativeArtifacts,
  engines: { node: execFileSync(node, ['--version'], { encoding: 'utf8' }).trim() },
  binaryOptimizations,
  componentBytesExcludeManifest: true, components, packages: [...packages.values()].map(pkg => ({ name: pkg.name, version: pkg.manifest.version, license: pkg.manifest.license ?? null, destinations: pkg.destinations })).filter(pkg => pkg.destinations.length) };
write(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'metadata');
// No source/build/cache dependency, absolute links, or duplicate workspace copy can enter the archive.
let bytes = 0, allocatedBytes = 0, allocatedDirectoryBytes = statSync(stage).blocks * 512, count = 0;
function inventory(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name), info = lstatSync(path);
    assert.ok(!info.isSymbolicLink(), `Release contains a symlink: ${path}`);
    if (info.isDirectory()) { allocatedDirectoryBytes += info.blocks * 512; inventory(path); }
    else { assert.ok(info.isFile()); bytes += info.size; allocatedBytes += info.blocks * 512; count++; }
  }
}
inventory(stage);
const archive = join(out, `can-${version}-${platform}.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', out, 'can'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
const archiveBytes = statSync(archive).size;
const archiveSha256 = sha(readFileSync(archive));
writeFileSync(`${archive}.sha256`, `${archiveSha256}  ${basename(archive)}\n`);
copyFileSync(join(root, 'scripts/install.sh'), join(out, 'install.sh'));
packBrowserDevelopmentTools({ checkout: root, out, version });
writeFileSync(join(out, 'install-local.sh'), `#!/bin/sh\nset -eu\ndirectory=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)\nexec /bin/sh "$directory/install.sh" --archive "$directory/${basename(archive)}" --checksum ${archiveSha256} --version ${version}\n`);
chmodSync(join(out, 'install-local.sh'), 0o755);

const completeComponents = {};
for (const { group, bytes } of files.values()) completeComponents[group] = (completeComponents[group] ?? 0) + bytes;
assert.equal(Object.values(completeComponents).reduce((sum, value) => sum + value, 0), bytes);
const report = { version, platform, archive: basename(archive), downloadBytes: archiveBytes, installedFileBytes: bytes, allocatedFileBytes: allocatedBytes, installedDiskBytes: allocatedBytes + allocatedDirectoryBytes, files: count, components: completeComponents, packages: manifest.packages.length };
writeFileSync(join(out, 'size-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
