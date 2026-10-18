import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

const installer = fileURLToPath(new URL('./install.sh', import.meta.url));
const supported = (process.platform === 'darwin' && process.arch === 'arm64') || (process.platform === 'linux' && process.arch === 'x64');

// Tiny ustar fixtures let traversal and link tests retain the exact malicious
// member names, without a local tar command sanitizing them during creation.
function tarball(entries) {
  const chunks = [];
  for (const { name, body = '', type = '0', link = '', mode = 0o644 } of entries) {
    const bytes = Buffer.from(body);
    const header = Buffer.alloc(512);
    const field = (value, start, size) => header.write(String(value).slice(0, size), start, size, 'utf8');
    const octal = (value, start, size) => field(value.toString(8).padStart(size - 1, '0') + '\0', start, size);
    field(name, 0, 100); octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(bytes.length, 124, 12); octal(0, 136, 12); field('        ', 148, 8);
    field(type, 156, 1); field(link, 157, 100); field('ustar\0', 257, 6); field('00', 263, 2);
    field([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function fixture(t, shell = 'bash') {
  const temporary = mkdtempSync(join(tmpdir(), 'can installer test '));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const home = join(temporary, "home user's space");
  const root = join(home, 'Can tools');
  mkdirSync(home);
  const env = { ...process.env, HOME: home, CAN_INSTALL_DIR: root, SHELL: `/bin/${shell}` };
  delete env.ZDOTDIR;
  function archive(version, extra = [], launcher = `#!/bin/sh\nprintf 'Can ${version}\\n'\n`) {
    const bytes = tarball([
      { name: 'can/', type: '5', mode: 0o755 },
      { name: 'can/bin/', type: '5', mode: 0o755 },
      { name: 'can/bin/can', mode: 0o755, body: launcher },
      { name: 'can/manifest.json', body: JSON.stringify({ version }) },
      ...extra,
    ]);
    const file = join(temporary, `can-${version}.tar.gz`);
    writeFileSync(file, bytes);
    return { file, checksum: createHash('sha256').update(bytes).digest('hex'), version };
  }
  const install = (release, args = []) => spawnSync('/bin/sh', [installer, '--archive', release.file, '--checksum', release.checksum, '--version', release.version, ...args], { env, encoding: 'utf8' });
  return { temporary, home, root, env, archive, install };
}
function succeeds(result) { assert.equal(result.status, 0, result.stderr + result.stdout); }
function fails(result, message) { assert.notEqual(result.status, 0, result.stdout); assert.match(result.stderr, message); }

test('installs with spaces and quotes, activates upgrades, and configures PATH once', { skip: !supported }, t => {
  const f = fixture(t);
  const first = f.archive('1.0.0');
  succeeds(f.install(first));
  const previous = readlinkSync(join(f.root, 'current'));
  assert.equal(readlinkSync(join(f.root, 'bin/can')), '../current/bin/can');
  const rc = join(f.home, '.bashrc');
  const initialConfig = readFileSync(rc, 'utf8');
  const shell = spawnSync('/bin/sh', ['-c', '. "$HOME/.bashrc"; can --version'], { env: f.env, encoding: 'utf8' });
  succeeds(shell);
  assert.equal(shell.stdout.trim(), 'Can 1.0.0');
  succeeds(f.install(first));
  assert.equal(readFileSync(rc, 'utf8'), initialConfig);
  const second = f.archive('1.1.0');
  succeeds(f.install(second));
  assert.notEqual(readlinkSync(join(f.root, 'current')), previous);
  assert.ok(existsSync(join(f.root, previous, 'bin/can')));
  const command = spawnSync(join(f.root, 'bin/can'), ['--version'], { env: f.env, encoding: 'utf8' });
  succeeds(command);
  assert.equal(command.stdout.trim(), 'Can 1.1.0');
  assert.equal(readFileSync(rc, 'utf8'), initialConfig);
  assert.ok(!readdirSync(f.root).some(entry => entry.startsWith('.stage.') || entry === '.install-lock'));
});

test('checksum tampering and broken launchers preserve the active release', { skip: !supported }, t => {
  const f = fixture(t);
  succeeds(f.install(f.archive('1')));
  const active = readlinkSync(join(f.root, 'current'));
  const damaged = f.archive('2');
  writeFileSync(damaged.file, 'tampered');
  fails(f.install(damaged), /checksum mismatch/);
  assert.equal(readlinkSync(join(f.root, 'current')), active);
  fails(f.install(f.archive('3', [], '#!/bin/sh\nexit 1\n')), /launcher check failed/);
  assert.equal(readlinkSync(join(f.root, 'current')), active);
  fails(f.install(f.archive('4', [], '#!/bin/sh\ncase "$1" in dev) exit 1 ;; esac\nprintf "Can 4\\n"\n')), /development-server check failed/);
  assert.equal(readlinkSync(join(f.root, 'current')), active);
  assert.equal(spawnSync(join(f.root, 'bin/can'), [], { encoding: 'utf8' }).stdout.trim(), 'Can 1');
});

test('pinned HTTPS download installs its matching archive and checksum', { skip: !supported }, t => {
  const f = fixture(t);
  const release = f.archive('2.0.0');
  const tools = join(f.temporary, 'tools');
  mkdirSync(tools);
  const curl = join(tools, 'curl');
  writeFileSync(curl, `#!/bin/sh
set -eu
output= url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --proto|--proto-redir) shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$url" >> "$CAN_TEST_REQUESTS"
case "$url" in
  "https://releases.example.test/can/v2.0.0/can-2.0.0-$CAN_TEST_PLATFORM.tar.gz") cp "$CAN_TEST_ARCHIVE" "$output" ;;
  "https://releases.example.test/can/v2.0.0/can-2.0.0-$CAN_TEST_PLATFORM.tar.gz.sha256") printf '%s  release.tar.gz\\n' "$CAN_TEST_CHECKSUM" > "$output" ;;
  *) exit 22 ;;
esac
`);
  chmodSync(curl, 0o755);
  const env = { ...f.env, PATH: `${tools}:${process.env.PATH}`, CAN_TEST_ARCHIVE: release.file,
    CAN_TEST_CHECKSUM: release.checksum, CAN_TEST_PLATFORM: process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64',
    CAN_TEST_REQUESTS: join(f.temporary, 'requests') };
  const run = base => spawnSync('/bin/sh', [installer, '--version', release.version, '--base-url', base], { env, encoding: 'utf8' });
  succeeds(run('https://releases.example.test/can'));
  assert.equal(readFileSync(env.CAN_TEST_REQUESTS, 'utf8').trim().split('\n').length, 2);
  const current = readlinkSync(join(f.root, 'current'));
  fails(run('http://releases.example.test/can'), /must use HTTPS/);
  assert.equal(readlinkSync(join(f.root, 'current')), current);
});

test('refuses traversal, absolute paths, symlinks, and hard links before extraction', { skip: !supported }, t => {
  const f = fixture(t);
  succeeds(f.install(f.archive('1')));
  const active = readlinkSync(join(f.root, 'current'));
  const cases = [
    { name: 'can/../../escaped', body: 'escaped' },
    { name: '/tmp/can-installer-escaped', body: 'escaped' },
    { name: 'can/link', type: '2', link: '../../escaped' },
    { name: 'can/link', type: '1', link: 'can/bin/can' },
  ];
  for (let index = 0; index < cases.length; index++) {
    fails(f.install(f.archive(`bad-${index}`, [cases[index]])), /unsafe archive|outside can|links and special/);
    assert.equal(readlinkSync(join(f.root, 'current')), active);
  }
  assert.ok(!existsSync(join(f.temporary, 'escaped')));
});

test('refuses foreign roots, launchers, current links, and active locks', { skip: !supported }, t => {
  const f = fixture(t);
  const release = f.archive('1');
  mkdirSync(f.root);
  writeFileSync(join(f.root, 'personal.txt'), 'keep');
  fails(f.install(release), /foreign installation/);
  assert.equal(readFileSync(join(f.root, 'personal.txt'), 'utf8'), 'keep');
  rmSync(f.root, { recursive: true });
  succeeds(f.install(release));
  rmSync(join(f.root, 'bin/can'));
  writeFileSync(join(f.root, 'bin/can'), 'keep');
  fails(f.install(release), /foreign launcher/);
  assert.equal(readFileSync(join(f.root, 'bin/can'), 'utf8'), 'keep');
  rmSync(join(f.root, 'bin/can'));
  rmSync(join(f.root, 'current'));
  symlinkSync(f.home, join(f.root, 'current'));
  fails(f.install(release), /foreign current/);
  rmSync(join(f.root, 'current'));
  mkdirSync(join(f.root, '.install-lock'));
  fails(f.install(release), /another installation is active/);
  assert.ok(existsSync(join(f.root, '.install-lock')));
});

for (const [shell, path] of [['zsh', '.zshrc'], ['fish', '.config/fish/config.fish']]) {
  test(`configures ${shell} PATH idempotently`, { skip: !supported }, t => {
    const f = fixture(t, shell);
    const release = f.archive('1');
    succeeds(f.install(release));
    const config = readFileSync(join(f.home, path), 'utf8');
    assert.match(config, /Can installer/);
    succeeds(f.install(release));
    assert.equal(readFileSync(join(f.home, path), 'utf8'), config);
    if (shell === 'zsh') {
      const result = spawnSync('/bin/sh', ['-c', '. "$HOME/.zshrc"; can --version'], { env: f.env, encoding: 'utf8' });
      succeeds(result);
      assert.equal(result.stdout.trim(), 'Can 1');
    }
  });
}

for (const shell of ['/bin/bash', '/bin/sh']) {
  test(`installs a complete installer streamed into ${shell}`, { skip: !supported }, t => {
    const f = fixture(t);
    const release = f.archive('3.0.0');
    const result = spawnSync(shell, ['-s', '--', '--archive', release.file, '--checksum', release.checksum, '--version', release.version], {
      env: f.env, input: readFileSync(installer), encoding: 'utf8',
    });
    succeeds(result);
    assert.equal(spawnSync(join(f.root, 'bin/can'), ['--version'], { encoding: 'utf8' }).stdout.trim(), 'Can 3.0.0');
  });

  test(`a truncated stream into ${shell} never starts installation`, { skip: !supported }, t => {
    const f = fixture(t);
    const release = f.archive('3.0.0');
    const source = readFileSync(installer, 'utf8');
    const truncated = source.slice(0, source.indexOf('# Quote literal paths'));
    const result = spawnSync(shell, ['-s', '--', '--archive', release.file, '--checksum', release.checksum, '--version', release.version], {
      env: f.env, input: truncated, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(f.root), false);
  });
}

test('piped default installer resolves latest then fetches GitHub release assets', { skip: !supported }, t => {
  const f = fixture(t);
  const release = f.archive('3.0.0');
  const tools = join(f.temporary, 'tools');
  mkdirSync(tools);
  writeFileSync(join(tools, 'curl'), `#!/bin/sh
set -eu
output= url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --proto|--proto-redir|--write-out) shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$url" >> "$CAN_TEST_REQUESTS"
base=https://github.com/veighnsche/canlang/releases
case "$url" in
  "$base/latest") printf '%s' "$base/tag/v3.0.0" ;;
  "$base/download/v3.0.0/can-3.0.0-$CAN_TEST_PLATFORM.tar.gz") cp "$CAN_TEST_ARCHIVE" "$output" ;;
  "$base/download/v3.0.0/can-3.0.0-$CAN_TEST_PLATFORM.tar.gz.sha256") printf '%s  archive.tar.gz\\n' "$CAN_TEST_CHECKSUM" > "$output" ;;
  *) exit 22 ;;
esac
`);
  chmodSync(join(tools, 'curl'), 0o755);
  const env = { ...f.env, PATH: `${tools}:${process.env.PATH}`, CAN_TEST_ARCHIVE: release.file,
    CAN_TEST_CHECKSUM: release.checksum, CAN_TEST_PLATFORM: process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64',
    CAN_TEST_REQUESTS: join(f.temporary, 'requests') };
  succeeds(spawnSync('/bin/bash', [], { env, input: readFileSync(installer), encoding: 'utf8' }));
  assert.deepEqual(readFileSync(env.CAN_TEST_REQUESTS, 'utf8').trim().split('\n'), [
    'https://github.com/veighnsche/canlang/releases/latest',
    `https://github.com/veighnsche/canlang/releases/download/v3.0.0/can-3.0.0-${env.CAN_TEST_PLATFORM}.tar.gz`,
    `https://github.com/veighnsche/canlang/releases/download/v3.0.0/can-3.0.0-${env.CAN_TEST_PLATFORM}.tar.gz.sha256`,
  ]);
});
