#!/usr/bin/env node
/** Release builder; developer dependencies are used here, never by the installer. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const host = `${process.platform}-${process.arch}`;
const targets = { 'darwin-arm64': 'aarch64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-gnu' };
assert.ok(targets[host], `Unsupported release host ${host}`);
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? 'compiler/target');
const buildEnv = { ...process.env, CARGO_TARGET_DIR: target, CARGO_INCREMENTAL: '0',
  CARGO_PROFILE_DEV_DEBUG: '0', CARGO_PROFILE_TEST_DEBUG: '0', CARGO_BUILD_JOBS: '2' };
const run = (command, args, extra = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', ...extra });
run('bun', ['run', 'check:dependencies']);
run('bun', ['run', 'build']);
run('bun', ['run', 'catalog']);
run('cargo', ['build', '--release', '--locked', '--manifest-path', 'compiler/Cargo.toml'], { env: buildEnv });
run('cargo', ['build', '--release', '--locked', '--manifest-path', 'dev-server/Cargo.toml'], { env: buildEnv });
run('python3', ['scripts/check-compiler-release-notices.py', '--target', targets[host], '--output-dir', resolve(target, 'release')]);
run('python3', ['scripts/check-dev-server-release-notices.py', '--target', targets[host], '--output-dir', resolve(target, 'release')]);
mkdirSync(resolve(root, 'output/install-tools'), { recursive: true });
for (const name of ['package.json', 'bun.lock']) copyFileSync(resolve(root, 'scripts/distribution', name), resolve(root, 'output/install-tools', name));
run('bun', ['install', '--production', '--ignore-scripts', '--frozen-lockfile', '--cwd', 'output/install-tools']);
run(process.execPath, ['scripts/pack-install.mjs', '--compiler', resolve(target, 'release/can'), '--dev-server', resolve(target, 'release/can-dev'), ...process.argv.slice(2)]);
