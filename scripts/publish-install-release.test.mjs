import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareRelease, publishRelease } from './publish-install-release.mjs';

function fixture(t, version = '0.1.0') {
  const checkout = mkdtempSync(join(tmpdir(), 'can-release-'));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  mkdirSync(join(checkout, 'scripts'));
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(checkout, 'scripts/install.sh'), '#!/bin/sh\necho install\n');
  const artifacts = join(checkout, 'artifacts');
  for (const platform of ['darwin-arm64', 'linux-x64']) {
    const directory = join(artifacts, platform);
    mkdirSync(directory, { recursive: true });
    const name = `can-${version}-${platform}.tar.gz`;
    const bytes = Buffer.from(`qualified archive fixture for ${platform}`);
    writeFileSync(join(directory, name), bytes);
    writeFileSync(join(directory, `${name}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
    writeFileSync(join(directory, 'verification.json'), JSON.stringify({ platform, archive: `/runner/output/${name}`, passed: true, checks: ['installed external app'] }));
    writeFileSync(join(directory, 'install.sh'), '#!/bin/sh\necho install\n');
  }
  return { checkout, artifacts, event: 'push', ref: `refs/tags/v${version}`, repo: 'veighnsche/canlang', sha: 'a'.repeat(40) };
}

test('publishes exactly both archives, their checksums and the canonical installer after draft upload', t => {
  const plan = prepareRelease(fixture(t));
  assert.equal(plan.assets.length, 5);
  assert.equal(new Set(plan.assets.map(path => path.split('/').at(-1))).size, 5);
  const commands = [];
  publishRelease(plan, args => { commands.push(args); return ''; });
  assert.deepEqual(commands.map(args => args.slice(0, 2)), [['api', '--paginate'], ['release', 'create'], ['release', 'upload'], ['release', 'edit']]);
  assert.ok(commands[1].includes('--draft'));
  assert.ok(commands[1].includes('--verify-tag'));
  assert.ok(commands[3].includes('--draft=false'));
  assert.ok(!commands.flat().includes('--clobber'));
  assert.ok(!commands[1].includes('--prerelease'));
});

test('manual runs, version mismatch and noncanonical repositories fail before publication', t => {
  const inputs = fixture(t);
  assert.throws(() => prepareRelease({ ...inputs, event: 'workflow_dispatch' }), /assembles artifacts only/);
  assert.throws(() => prepareRelease({ ...inputs, ref: 'refs/tags/v9.9.9' }), /tag must match/);
  assert.throws(() => prepareRelease({ ...inputs, repo: 'someone/fork' }), /canonical repository/);
});

test('rejects checksum tampering and unsuccessful platform qualification', t => {
  const inputs = fixture(t);
  const directory = join(inputs.artifacts, 'linux-x64');
  writeFileSync(join(directory, 'verification.json'), JSON.stringify({ passed: false }));
  assert.throws(() => prepareRelease(inputs), /Unqualified platform/);
  writeFileSync(join(directory, 'can-0.1.0-linux-x64.tar.gz'), 'tampered');
  assert.throws(() => prepareRelease(inputs), /Checksum mismatch/);
});

test('rejects platform installer drift', t => {
  const inputs = fixture(t);
  writeFileSync(join(inputs.artifacts, 'linux-x64/install.sh'), '#!/bin/sh\necho changed\n');
  assert.throws(() => prepareRelease(inputs), /Installer differs/);
});

test('existing release or failed upload prevents publishing partial assets', t => {
  const plan = prepareRelease(fixture(t));
  const existingCommands = [];
  assert.throws(() => publishRelease(plan, args => { existingCommands.push(args[0]); return '123\n'; }), /already exists/);
  assert.deepEqual(existingCommands, ['api']);
  for (const failAt of ['create', 'upload']) {
    const commands = [];
    assert.throws(() => publishRelease(plan, args => { commands.push(args[1]); if (args[1] === failAt) throw new Error(failAt === 'create' ? 'release already exists' : 'upload failed'); return ''; }), /already exists|upload failed/);
    assert.ok(!commands.includes('edit'));
    assert.equal(commands.at(-1), failAt);
  }
});

test('prerelease versions retain prerelease status', t => {
  const plan = prepareRelease(fixture(t, '0.2.0-beta.1'));
  const commands = [];
  publishRelease(plan, args => { commands.push(args); return ''; });
  assert.ok(commands[1].includes('--prerelease'));
});
