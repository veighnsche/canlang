/** Native target closure still uses the canonical portable bundle and Files issuer. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect } from 'vitest';
import { CONTRACTS_VERSION, type CompatibilityDescriptor, type EnvironmentSelection } from '@canlang/contracts';
import { distribution } from '@canlang/values/distribution';
import { parseArtifactText } from '../src/runtime/artifact.js';
import { buildSodaBundle, preflightSodaDeployment } from '../src/deploy/soda.js';
import { assertLinksResolve, assertWorkerdLoadable } from '../src/deploy/bundle.js';
import { scanModuleImports } from '../src/deploy/module-imports.js';

it('assembles the real app actor and pure activation closure with one defining Files issuer', () => {
  const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const fixture = join(repo, 'scripts/fixtures/soda-runtime.can');
  const source = readFileSync(fixture);
  const { artifact } = parseArtifactText(execFileSync(join(repo, 'compiler/target/release/can'), [
    'compile', '--format=json', '--native-scenario-receipts', `--catalog=${fileURLToPath(distribution.catalog)}`, fixture,
  ], { cwd: repo, encoding: 'utf8' }), fixture);
  const requirements = [{ binding: 'DB', kind: 'd1' as const, logicalName: 'identity' },
    { binding: 'STATE_DB', kind: 'd1' as const, logicalName: 'state' }];
  const descriptor: CompatibilityDescriptor = { identity: { appName: 'SodaRuntime',
    sourceRevision: createHash('sha256').update(source).digest('hex'), languageVersion: artifact.language_version,
    compilerVersion: artifact.tool_version, contractsVersion: CONTRACTS_VERSION,
    artifactDigest: createHash('sha256').update(JSON.stringify(artifact)).digest('hex') },
    requiredCapabilities: artifact.requires.map(item => item.capability), resourceBindings: requirements,
    secrets: [], schedules: [{ handler: 'SodaRuntime.fire', everyMilliseconds: '1000' }] };
  const environment: EnvironmentSelection = { environment: 'soda-bundle-test',
    resources: requirements.map(requirement => ({ requirement, resourceId: requirement.logicalName })), secretsPresent: [],
    vars: { CAN_AUTH_ORIGIN: 'https://app.soda.test', CAN_DEPLOYMENT_BASE: 'https://app.soda.test' } };
  const result = buildSodaBundle(artifact, descriptor, environment, '2026-07-15');
  const { modules, binaries } = result.bundle;
  expect(result.bundle.mainModule).toBe('worker/soda.js');
  for (const key of ['runtime/soda-application.js', 'deploy/activate.js', 'deploy/compat.js', 'deploy/installed.js',
    'vendor/work/recovery/index.js', 'vendor/files/host/durable-sqlite.js', 'vendor/files/host/sqlite-core.js']) {
    expect(modules[key], key).toBeDefined();
  }
  // Both physical kernel and canonical authorization read the same issuer module.
  expect(modules['vendor/files/host/sqlite-core.js']).toContain('../finalize/index.js');
  expect(modules['runtime/bound-files.js']).toContain('../vendor/files/finalize/index.js');
  expect(Object.keys(modules).filter(key => key.endsWith('files/finalize/index.js'))).toEqual(['vendor/files/finalize/index.js']);
  for (const [key, js] of Object.entries(modules)) {
    expect(scanModuleImports(js, key).some(item => item.specifier?.startsWith('node:')), key).toBe(false);
  }
  expect(modules['worker/artifact.js']).toContain('"active":false');
  assertLinksResolve(modules, Object.keys(binaries));
  assertWorkerdLoadable(modules);
  expect(() => preflightSodaDeployment(artifact, descriptor, { ...environment,
    vars: { CAN_AUTH_ORIGIN: 'http://127.0.0.1:3000' } })).toThrow(/File receivers require an HTTPS/);
  expect(() => preflightSodaDeployment(artifact, { ...descriptor, resourceBindings: [requirements[0]!] }, environment))
    .toThrow(/State D1 binding STATE_DB/);
  expect(() => preflightSodaDeployment(artifact, { ...descriptor,
    resourceBindings: [...requirements, { binding: 'OBJECTS', kind: 'r2', logicalName: 'files' }] }, environment))
    .toThrow(/does not support required r2/);
}, 60000);
