import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('node:module', async importOriginal => {
  const actual = await importOriginal<typeof import('node:module')>();
  return { ...actual, createRequire: (from: string | URL) => {
    const real = actual.createRequire(from);
    return { resolve: (specifier: string) => {
      if (specifier === '@canlang/testkit') return real.resolve(specifier);
      // Required producers are finite installed fixtures; optional Testkit is
      // resolved by Node from the actual invoking application's node_modules.
      const request = specifier.replace(/\/package\.json$/, '');
      const name = request.startsWith('@canlang/') ? request.split('/').slice(0, 2).join('/') : request;
      return join(fixture.root, 'required', encodeURIComponent(name), 'dist', 'index.js');
    } };
  } };
});
import { installedOwnedSourceInputs, installedPortableBundleInputs } from '../src/dev/preview-inputs.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function prepare() {
  root = await mkdtemp(join(tmpdir(), 'can-preview-inputs-'));
  fixture.root = root;
  await writeFile(join(root, 'package.json'), '{}');
  const names = ['cloudflare', 'contracts', 'interfaces', 'identity', 'state', 'ui', 'stdlib', 'values', 'work', 'services']
    .map(name => `@canlang/${name}`).concat(['@modelcontextprotocol/sdk', 'cookie', '@scure/base', 'csv-parse', '@noble/hashes/sha2.js', '@jridgewell/sourcemap-codec']);
  for (const name of names) {
    const path = join(root, 'required', encodeURIComponent(name));
    await mkdir(join(path, 'dist'), { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
    await writeFile(join(path, 'dist', 'index.js'), 'export {};');
    if (name === '@canlang/values') {
      await writeFile(join(path, 'Cargo.toml'), '');
      await writeFile(join(path, 'Cargo.lock'), '');
      await mkdir(join(path, 'semantics', 'src'), { recursive: true });
      await writeFile(join(path, 'semantics', 'src', 'lib.rs'), '');
      await mkdir(join(path, 'bindings', 'generated'), { recursive: true });
      await writeFile(join(path, 'bindings', 'generated', 'BUILD.json'), '{}');
    }
    if (name === '@canlang/ui') await writeFile(join(path, 'themes.css'), '');
    // The capture freshness check requires installed JS newer than sources.
    await writeFile(join(path, 'dist', 'index.js'), 'export {};');
  }
  return join(root, 'node_modules', '@canlang', 'testkit');
}

it('absent optional Testkit admits inventory and a later installation changes its closure', async () => {
  const kit = await prepare();
  const before = installedPortableBundleInputs(root);
  expect(before.some(input => input.name.startsWith('@canlang/testkit@'))).toBe(false);
  expect(installedOwnedSourceInputs(root).some(input => input.name.startsWith('source:@canlang/testkit@'))).toBe(false);
  await mkdir(join(kit, 'src'), { recursive: true });
  await mkdir(join(kit, 'dist'), { recursive: true });
  await writeFile(join(kit, 'package.json'), JSON.stringify({ name: '@canlang/testkit', version: '1.0.0', main: './dist/index.js' }));
  await writeFile(join(kit, 'src', 'index.ts'), 'export {};');
  await writeFile(join(kit, 'dist', 'index.js'), 'export {};');
  expect(installedPortableBundleInputs(root).some(input => input.name === '@canlang/testkit@1.0.0/dist/index.js')).toBe(true);
  expect(installedOwnedSourceInputs(root).some(input => input.name === 'source:@canlang/testkit@1.0.0/src/index.ts')).toBe(true);
});

it('does not treat installed Testkit exports errors as package absence', async () => {
  const kit = await prepare();
  await mkdir(kit, { recursive: true });
  await writeFile(join(kit, 'package.json'), JSON.stringify({ name: '@canlang/testkit', version: '1.0.0', exports: { './other': './other.js' } }));
  expect(() => installedPortableBundleInputs(root)).toThrow(/No "exports" main defined/);
});

it('does not treat an installed Testkit missing entry as package absence', async () => {
  const kit = await prepare();
  await mkdir(kit, { recursive: true });
  await writeFile(join(kit, 'package.json'), JSON.stringify({ name: '@canlang/testkit', version: '1.0.0', main: './dist/missing.js' }));
  expect(() => installedPortableBundleInputs(root)).toThrow(/Cannot find module/);
});
