#!/usr/bin/env node
/** Publish qualified core archives, the installer and separate browser sidecars. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// macOS publication is deferred until its standalone installer is qualified.
const platforms = ['linux-x64'];
const repository = 'veighnsche/canlang';
const read = path => {
  assert.ok(lstatSync(path).isFile(), `Expected a regular release input: ${path}`);
  return readFileSync(path);
};

export function prepareRelease({ checkout, artifacts, event, ref, repo, sha }) {
  assert.equal(event, 'push', 'Manual dispatch assembles artifacts only');
  assert.equal(repo, repository, 'Standalone releases belong to the canonical repository');
  const { version } = JSON.parse(read(join(checkout, 'package.json')));
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, 'Expected a release package version');
  assert.equal(ref, `refs/tags/v${version}`, 'Release tag must match package.json version exactly');
  assert.match(sha, /^[0-9a-f]{40,64}$/, 'Expected the checked-out release commit');
  const installer = read(join(checkout, 'scripts/install.sh'));
  const assets = [];
  const browserName = `can-browser-development-tools-${version}.tar.gz`;
  const browserInputs = [['install-browser-tools.sh', 'scripts/install-browser-tools.sh'],
    ['browser-development/package.json', 'scripts/distribution/browser/package.json'],
    ['browser-development/bun.lock', 'scripts/distribution/browser/bun.lock']];
  const verifyChecksum = (directory, name) => {
    const archive = join(directory, name), checksum = `${archive}.sha256`;
    const expected = read(checksum).toString().match(/^([0-9a-f]{64})[ \t]+\*?([^\r\n]+)\r?\n?$/);
    assert.ok(expected && expected[2] === name, `Checksum must name ${name}`);
    assert.equal(createHash('sha256').update(read(archive)).digest('hex'), expected[1], `Checksum mismatch: ${name}`);
    return [archive, checksum];
  };
  for (const platform of platforms) {
    const directory = join(artifacts, platform);
    const name = `can-${version}-${platform}.tar.gz`;
    assets.push(...verifyChecksum(directory, name));
    const qualification = JSON.parse(read(join(directory, 'verification.json')));
    assert.equal(qualification.passed, true, `Unqualified platform: ${platform}`);
    assert.equal(qualification.platform, platform);
    assert.equal(basename(qualification.archive), name);
    assert.ok(Array.isArray(qualification.checks) && qualification.checks.length > 0, `Missing qualification checks: ${platform}`);
    assert.ok(read(join(directory, 'install.sh')).equals(installer), `Installer differs from tagged source: ${platform}`);
    const [browserArchive] = verifyChecksum(directory, browserName);
    const tar = args => execFileSync('tar', args, { env: { ...process.env, TAR_OPTIONS: '' } });
    assert.deepEqual(tar(['-tzf', browserArchive]).toString().trimEnd().split('\n').sort(), browserInputs.map(([member]) => member).sort(), `Unexpected browser development sidecars: ${platform}`);
    for (const [member, source] of browserInputs) {
      assert.ok(tar(['-xOf', browserArchive, member]).equals(read(join(checkout, source))), `Browser development sidecar differs from tagged source: ${platform}/${member}`);
    }
  }
  assets.push(join(artifacts, platforms[0], 'install.sh'));
  assets.push(...verifyChecksum(join(artifacts, platforms[0]), browserName));
  const toolsDirectory = join(artifacts, 'tools');
  const descriptorPath = join(toolsDirectory, 'canlang-release.json');
  const descriptor = JSON.parse(read(descriptorPath));
  assert.equal(descriptor.sourceRevision, sha, 'Offline tools must match the tagged source');
  assert.equal(descriptor.archiveFilename, 'canlang-tools-linux-x86_64.tar.gz');
  const toolsArchive = join(toolsDirectory, descriptor.archiveFilename);
  assert.equal(createHash('sha256').update(read(toolsArchive)).digest('hex'), descriptor.sha256,
    'Offline tools checksum mismatch');
  assert.ok(descriptor.versions.compiler.startsWith(`can ${version} (`), 'Offline compiler release version differs');
  assets.push(toolsArchive, descriptorPath);
  return { tag: `v${version}`, version, sha, repo, assets, prerelease: version.split('+')[0].includes('-') };
}

export function publishRelease(plan, gh = (args, capture = false) => execFileSync('gh', args, {
  encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
})) {
  // Query published releases and drafts; auth/API failures stop here as well.
  // Never edit or resume an existing release or use upload --clobber. On failure,
  // retain any new draft for deliberate recovery without publishing partials.
  const common = ['--repo', plan.repo];
  const existing = gh(['api', '--paginate', `repos/${plan.repo}/releases`, '--jq',
    `.[] | select(.tag_name == ${JSON.stringify(plan.tag)}) | .id`], true);
  assert.equal(String(existing ?? '').trim(), '', `Release ${plan.tag} already exists; preserve it and recover deliberately`);
  gh(['release', 'create', plan.tag, ...common, '--draft', '--verify-tag', '--target', plan.sha,
    '--title', `Can ${plan.version}`, '--notes',
    `Standalone Can for Linux x64 (glibc). Installer: https://sodaos.dev/CanLang/install.sh . Browser development tools are optional and separate.\n\nOffline SodaOS tools and their source/checksum descriptor are included. CLI container: ghcr.io/veighnsche/canlang:${plan.tag}.`,
    ...(plan.prerelease ? ['--prerelease'] : [])]);
  gh(['release', 'upload', plan.tag, ...plan.assets, ...common]);
  gh(['release', 'edit', plan.tag, ...common, '--draft=false', '--verify-tag']);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Usage: publish-install-release.mjs ARTIFACTS_DIRECTORY');
  const checkout = fileURLToPath(new URL('..', import.meta.url));
  const plan = prepareRelease({ checkout, artifacts: resolve(process.argv[2]), event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF, repo: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA });
  publishRelease(plan);
}
