#!/bin/sh
# Explicit opt-in developer tooling. Never part of the production Can closure.
set -eu
fail() { printf 'can browser development tools: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 0 ] || fail 'usage: install-browser-tools.sh (CAN_INSTALL_ROOT and CAN_BROWSER_TOOLS_ROOT may override locations)'
[ -n "${HOME:-}" ] || fail 'HOME must be set'
source_dir=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
can_root=${CAN_INSTALL_ROOT:-${CAN_INSTALL_DIR:-$HOME/.can}/current}
can_root=$(CDPATH= cd -P -- "$can_root" && pwd) || fail 'install Can first'
[ -x "$can_root/libexec/node" ] || fail 'the private Can Node runtime is unavailable'
if [ -f "$source_dir/distribution/browser/package.json" ]; then inputs=$source_dir/distribution/browser; else inputs=$source_dir/browser-development; fi
[ -f "$inputs/package.json" ] && [ -f "$inputs/bun.lock" ] || fail 'pinned browser development manifest/lock is missing'
destination=${CAN_BROWSER_TOOLS_ROOT:-$HOME/.local/share/can/development/browser/1.63.0}
case "$destination" in /*) ;; *) destination=$PWD/$destination ;; esac
[ ! -e "$destination" ] && [ ! -L "$destination" ] || fail "destination exists; preserve active sessions and remove an obsolete developer installation deliberately: $destination"
parent=$(dirname -- "$destination")
mkdir -p "$parent"
lock=$destination.install-lock
mkdir "$lock" 2>/dev/null || fail 'another browser development installation is active'
stage=
cleanup() { [ -z "$stage" ] || rm -rf "$stage"; rmdir "$lock" 2>/dev/null || :; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
stage=$(mktemp -d "$parent/.browser-stage.XXXXXXXX")
cp "$inputs/package.json" "$inputs/bun.lock" "$stage/"
printf 'Installing optional browser development packages in %s\n' "$destination"
"$can_root/libexec/node" --input-type=module - "$stage" <<'JS'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const root = process.argv[2];
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// This repository-owned JSONC lock uses trailing commas and no comments. Parse
// data only; constrain its tiny graph before deriving any download or file path.
const lock = JSON.parse(readFileSync(join(root, 'bun.lock'), 'utf8').replace(/,\s*([}\]])/g, '$1'));
const names = ['@playwright/test', 'playwright', 'playwright-core'];
const version = '1.63.0';
assert.deepEqual(manifest.devDependencies, { '@playwright/test': version });
assert.equal(lock.lockfileVersion, 2);
assert.equal(lock.configVersion, 1);
assert.deepEqual(Object.keys(lock.packages).sort(), [...names].sort());
const tarEnvironment = { ...process.env, TAR_OPTIONS: '', COPYFILE_DISABLE: '1' };
for (const [index, name] of names.entries()) {
  const entry = lock.packages[name];
  assert.equal(entry.length, 4);
  assert.equal(entry[0], `${name}@${version}`);
  assert.equal(entry[1], '');
  const dependency = names[index + 1];
  assert.deepEqual(entry[2].dependencies ?? {}, dependency ? { [dependency]: version } : {});
  assert.match(entry[3], /^sha512-[A-Za-z0-9+/]{86}==$/);
  const url = `https://registry.npmjs.org/${name}/-/${basename(name)}-${version}.tgz`;
  console.log(`Downloading optional ${name}@${version}`);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  assert.ok(response.ok, `${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha512').update(bytes).digest();
  const expected = Buffer.from(entry[3].slice('sha512-'.length), 'base64');
  assert.equal(expected.length, actual.length);
  assert.ok(timingSafeEqual(actual, expected), `Checksum mismatch for ${name}`);
  const archive = join(root, `.package-${index}.tgz`);
  writeFileSync(archive, bytes);
  const tar = args => execFileSync('tar', args, { env: tarEnvironment, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const members = tar(['-tzf', archive]).trimEnd().split('\n');
  assert.ok(members.length > 0);
  for (const member of members) {
    assert.ok((member === 'package' || member.startsWith('package/')) && !member.includes('\\') && !member.startsWith('/'), `Unsafe archive member: ${member}`);
    assert.ok(!member.split('/').some(part => part === '.' || part === '..'), `Unsafe archive path: ${member}`);
  }
  assert.ok(tar(['-tvzf', archive]).trimEnd().split('\n').every(line => line.startsWith('-') || line.startsWith('d')), `Links or special files in ${name}`);
  const destination = join(root, 'node_modules', name);
  mkdirSync(destination, { recursive: true });
  tar(['-xzf', archive, '-C', destination, '--strip-components', '1', '--no-same-owner', '--no-same-permissions']);
  const installed = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
  assert.equal(installed.name, name);
  assert.equal(installed.version, version);
  rmSync(archive);
}
JS
printf 'Downloading pinned headless Chromium for development checks\n'
PLAYWRIGHT_BROWSERS_PATH=$stage/browsers "$can_root/libexec/node" "$stage/node_modules/@playwright/test/cli.js" install chromium --only-shell
"$can_root/libexec/node" --input-type=module - "$stage" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
const root = process.argv[2], matches = [];
function walk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name === 'chrome-headless-shell') matches.push(file); } }
walk(join(root, 'browsers')); assert.equal(matches.length, 1, 'Expected exactly one pinned headless shell');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
manifest.canDevelopment = { browserExecutable: relative(root, matches[0]) };
writeFileSync(join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
JS
[ ! -e "$destination" ] && [ ! -L "$destination" ] || fail 'destination appeared while installing'
mv "$stage" "$destination"
stage=
"$can_root/libexec/node" --input-type=module - "$destination" <<'JS'
import { readdirSync, lstatSync } from 'node:fs'; import { join } from 'node:path';
let bytes = 0; function walk(dir) { for (const name of readdirSync(dir)) { const path = join(dir,name), info=lstatSync(path); if(info.isSymbolicLink())continue; if(info.isDirectory()) walk(path); else bytes+=info.size; } } walk(process.argv[2]);
console.log(`Browser development tools installed separately: ${bytes} file bytes. Production Can is unchanged.`);
JS
