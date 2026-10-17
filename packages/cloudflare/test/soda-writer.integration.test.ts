/** Production provisioning must leave the native host's private writer fence. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { CONTRACTS_VERSION } from '@canlang/contracts';
import { distribution } from '@canlang/values/distribution';
import { bootstrapD1Owner } from '@canlang/identity';
import { parseArtifactText } from '../src/runtime/artifact.js';
import { buildSodaBundle } from '../src/deploy/soda.js';
import { provisionSodaStorage } from '../src/deploy/soda-run.js';

function compiledInput() {
  const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const fixture = join(root, 'scripts/fixtures/soda-runtime.can');
  const { artifact } = parseArtifactText(execFileSync(join(root, 'compiler/target/release/can'), [
    'compile', '--format=json', '--native-scenario-receipts', `--catalog=${fileURLToPath(distribution.catalog)}`, fixture,
  ], { cwd: root, encoding: 'utf8' }), fixture);
  const requirements = [{ binding: 'DB', kind: 'd1' as const, logicalName: 'identity' },
    { binding: 'STATE_DB', kind: 'd1' as const, logicalName: 'state' }];
  return buildSodaBundle(artifact, { identity: { appName: 'SodaRuntime', sourceRevision: 'writer-proof',
    languageVersion: artifact.language_version, compilerVersion: artifact.tool_version,
    contractsVersion: CONTRACTS_VERSION, artifactDigest: createHash('sha256').update(JSON.stringify(artifact)).digest('hex') },
    requiredCapabilities: artifact.requires.map(item => item.capability), resourceBindings: requirements, secrets: [], schedules: [] },
  { environment: 'writer-proof', resources: requirements.map(requirement => ({ requirement, resourceId: requirement.logicalName })),
    secretsPresent: [], vars: { CAN_AUTH_ORIGIN: 'https://writer.soda.test' } }, '2026-07-15');
}

it('creates mode 0600 under umask 022, excludes writers, and recovers genuine D1 bootstrap after release', async () => {
  const directory = await mkdtemp(join(fileURLToPath(new URL('../../../', import.meta.url)), '.can-soda-writer-'));
  const input = compiledInput();
  const previousUmask = process.umask(0o022);
  let runtime: Awaited<ReturnType<typeof provisionSodaStorage>> | undefined;
  try {
    runtime = await provisionSodaStorage(input, directory);
    const lock = await lstat(join(directory, '.writer-lock'));
    assert.equal(lock.mode & 0o7777, 0o600); assert.equal(lock.uid, process.getuid?.()); assert.ok(lock.isFile());
    const credentials = { email: 'writer-owner@example.invalid', password: 'Synthetic writer bootstrap password' };
    const owner = await bootstrapD1Owner(await runtime.getD1Database('DB'), credentials);
    await assert.rejects(provisionSodaStorage(input, directory), /already has a writer/);
    await runtime.dispose(); runtime = undefined;
    runtime = await provisionSodaStorage(input, directory);
    assert.deepEqual(await bootstrapD1Owner(await runtime.getD1Database('DB'), credentials), owner);
    assert.equal((await lstat(join(directory, '.writer-lock'))).mode & 0o7777, 0o600);
  } finally { process.umask(previousUmask); await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('refuses unsafe existing files and links without changing or adopting their bytes or mode', async () => {
  const directory = await mkdtemp(join(fileURLToPath(new URL('../../../', import.meta.url)), '.can-soda-writer-unsafe-'));
  const input = compiledInput();
  const lock = join(directory, '.writer-lock');
  const target = join(directory, 'other-file');
  try {
    await writeFile(lock, 'unsafe retained lock', { mode: 0o644 }); await chmod(lock, 0o644);
    await assert.rejects(provisionSodaStorage(input, directory), /mode 0600/);
    assert.equal((await lstat(lock)).mode & 0o7777, 0o644); assert.equal(await readFile(lock, 'utf8'), 'unsafe retained lock');
    await rm(lock); await writeFile(target, 'link target', { mode: 0o600 }); await symlink(target, lock);
    await assert.rejects(provisionSodaStorage(input, directory), error => (error as NodeJS.ErrnoException).code === 'ELOOP');
    assert.ok((await lstat(lock)).isSymbolicLink()); assert.equal(await readFile(target, 'utf8'), 'link target');
    await rm(lock); execFileSync('mkfifo', ['-m', '600', lock]);
    await assert.rejects(provisionSodaStorage(input, directory), /private regular file/);
    assert.ok((await lstat(lock)).isFIFO());
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
