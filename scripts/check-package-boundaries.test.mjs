import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { test } from 'node:test';
import { checkoutInputs, checkPackageBoundaries } from './check-package-boundaries.mjs';

function fixture(t, { source = '', declared = true, rootSource, paths, bDependencies, version = 'workspace:*', aExports, cloudflareConsumers } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'can-package-boundaries-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => { const full = path.join(root, file); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, typeof content === 'string' ? content : `${JSON.stringify(content)}\n`); };
  write('package.json', { name: 'fixture', type: 'module', workspaces: ['packages/*'] });
  for (const name of ['a', 'b']) {
    write(`packages/${name}/package.json`, {
      name: `@canlang/${name}`, type: 'module',
      exports: name === 'a' && aExports ? { ...aExports, './asset.txt': './asset.txt' } : { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, './asset.txt': './asset.txt' },
      ...(name === 'a' && declared ? { dependencies: { '@canlang/b': version } } : {}),
      ...(name === 'b' && bDependencies ? { devDependencies: bDependencies } : {}),
    });
    write(`packages/${name}/tsconfig.json`, { compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: 'src', outDir: 'dist', ...(name === 'a' && paths ? { baseUrl: '.', paths } : {}) }, include: ['src'] });
    write(`packages/${name}/dist/index.js`, 'export const token = 1;\n');
    write(`packages/${name}/dist/index.d.ts`, 'export declare const token: 1;\n');
    write(`packages/${name}/asset.txt`, 'asset');
    write(`packages/${name}/src/index.ts`, name === 'a' ? source : 'export const token = 1;\n');
    const scope = path.join(root, 'node_modules/@canlang');
    mkdirSync(scope, { recursive: true });
    symlinkSync(path.join(root, 'packages', name), path.join(scope, name), 'junction');
  }
  if (cloudflareConsumers) {
    write('packages/cloudflare/package.json', { name: '@canlang/cloudflare', type: 'module' });
    write('packages/cloudflare/tsconfig.json', { compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: 'src', outDir: 'dist' }, include: ['src'] });
    for (const [file, content] of Object.entries(cloudflareConsumers)) write(`packages/cloudflare/${file}`, content);
  }
  if (rootSource) write('tools/probe.mjs', rootSource);
  return { root, write, check: () => checkPackageBoundaries(root) };
}

test('allows declared exported edges in imports, reexports, type queries, constants, and asset resolution', t => {
  const f = fixture(t, { source: `
    import { token } from '@canlang/b';
    export type { token as Token } from '@canlang/b';
    type Imported = import('@canlang/b').token;
    const SPECIFIER = '@canlang/' + 'b';
    await import(SPECIFIER);
    import.meta.resolve('@canlang/b/asset.txt');
    const same = await import('./local.js');
  ` });
  f.write('packages/a/src/local.ts', 'export {};\n');
  assert.deepEqual(f.check().errors, []);
});

test('allows exported owning-package self-reference reverse-mapped from outDir to rootDir', t => {
  const f = fixture(t, { aExports: { '.': './dist/index.js' }, source: "import { token } from '@canlang/a';\nvoid token;\n" });
  const configPath = path.join(f.root, 'packages/a/tsconfig.json');
  const raw = ts.readConfigFile(configPath, ts.sys.readFile).config;
  const config = ts.parseJsonConfigFileContent(raw, ts.sys, path.dirname(configPath));
  const source = path.join(f.root, 'packages/a/src/index.ts');
  assert.equal(ts.resolveModuleName('@canlang/a', source, config.options, ts.sys).resolvedModule?.resolvedFileName, source);
  assert.deepEqual(f.check().errors, []);
});

test('rejects a self-reference path alias that bypasses exported build targets', t => {
  const f = fixture(t, { paths: { '@canlang/a': ['./src/index.ts'] }, source: "import '@canlang/a';\n" });
  assert.equal(f.check().errors.filter(error => error.code === 'source-resolution').length, 1);
});

test('rejects undeclared local edges regardless of type-only or dynamic syntax', t => {
  const result = fixture(t, { declared: false, source: `
    import type { token } from '@canlang/b';
    export type { token as Token } from '@canlang/b';
    type Imported = import('@canlang/b').token;
    await import('@canlang/b');
    const SPECIFIER = '@canlang/b';
    await import(SPECIFIER);
    import.meta.resolve('@canlang/b/asset.txt');
  ` }).check();
  assert.equal(result.errors.filter(error => error.code === 'undeclared-dependency').length, 6);
});

test('rejects unexported subpaths and nonexistent runtime targets even when declarations exist', t => {
  const f = fixture(t, { source: "import '@canlang/b/private';\n" });
  assert.ok(f.check().errors.some(error => error.code === 'unexported-import'));
  rmSync(path.join(f.root, 'packages/b/dist/index.js'));
  assert.ok(f.check().errors.some(error => error.code === 'missing-export-target'));
  f.write('packages/a/src/index.ts', "import '@canlang/b';\n");
  rmSync(path.join(f.root, 'node_modules/@canlang/b'));
  assert.ok(f.check().errors.some(error => error.code === 'package-resolution'));
});

test('rejects sibling source/output shortcuts and root-tool shortcuts', t => {
  const result = fixture(t, {
    source: "import '../../b/src/index.js';\nexport * from '../../b/dist/index.js';\n",
    rootSource: "import '../packages/b/src/index.ts';\n",
  }).check();
  assert.equal(result.errors.filter(error => error.code === 'cross-package-import').length, 3);
});

test('allows only the registered Office Supplies reads from actual Cloudflare consumers', t => {
  const consumers = {
    'src/dev/session-service.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const project = fileURLToPath(new URL('../../../../', import.meta.url));
      readFileSync(join(project, 'tests/integration/can-dev-server/OfficeSupplies.can'));
    `,
    'test/compiler-check.integration.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join, resolve } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
      readFileSync(join(repo, 'tests/integration/can-dev-server/OfficeSupplies.can'));
    `,
  };
  const f = fixture(t, { cloudflareConsumers: consumers });
  const result = f.check();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.registered.map(entry => entry.consumer).sort(), [
    'packages/cloudflare/src/dev/session-service.test.ts',
    'packages/cloudflare/test/compiler-check.integration.test.ts',
  ]);
});

test('rejects other fixture reads and cross-package source imports from Cloudflare consumers', t => {
  const f = fixture(t, { cloudflareConsumers: {
    'test/compiler-check.integration.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join, resolve } from 'node:path';
      import { fileURLToPath } from 'node:url';
      import '../../a/src/index.js';
      const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
      readFileSync(join(repo, 'tests/integration/can-dev-server/Another.can'));
    `,
  } });
  const result = f.check();
  assert.ok(result.errors.some(error => error.code === 'cross-package-path'));
  assert.ok(result.errors.some(error => error.code === 'cross-package-import'));
  assert.deepEqual(result.registered, []);
});

test('rejects literal module paths escaping the entire checkout', t => {
  const result = fixture(t, { source: "import '../../../../outside/src/index.js';\n" }).check();
  assert.equal(result.errors.filter(error => error.code === 'cross-package-import').length, 1);
});

test('resolves TS aliases and prevents aliases from replacing exported builds with source', t => {
  const result = fixture(t, {
    paths: { bridge: ['../b/src/index.ts'], '@canlang/b': ['../b/src/index.ts'] },
    source: "import 'bridge';\nimport '@canlang/b';\n",
  }).check();
  assert.ok(result.errors.some(error => error.code === 'cross-package-import'));
  assert.ok(result.errors.some(error => error.code === 'source-resolution'));
});

test('folds constants, templates, and single-return helpers without ignoring lexical scope', t => {
  const result = fixture(t, { source: `
    const directory = '../../b';
    await import(directory + '/src/index.js');
    function modulePath(name: string) { return ['..', '..', 'b', 'src', name].join('/'); }
    await import(modulePath('index.js'));
    await import(\`\${directory}/dist/index.js\`);
    function runtime(directory: string) { return import(directory); }
  ` }).check();
  assert.equal(result.errors.filter(error => error.code === 'cross-package-import').length, 3);
  assert.equal(result.unresolved.filter(item => item.kind === 'module').length, 1);
});

test('checks package entries computed by simple suffix-edit helpers', t => {
  const result = fixture(t, { declared: false, source: `
    function specifier(name: string) { return '@canlang/b' + name.replace(/\\.ts$/, '').replace(/\\/index$/, ''); }
    await import(specifier('/index.ts'));
  ` }).check();
  assert.equal(result.errors.filter(error => error.code === 'undeclared-dependency').length, 1);
  assert.equal(result.unresolved.filter(item => item.kind === 'module').length, 0);
});

test('checks statically known module arguments passed to local lazy-loader wrappers', t => {
  const result = fixture(t, { source: `
    async function load(specifier: string) {
      let loaded;
      try { loaded = await import(specifier); } catch { throw new Error('missing'); }
      return loaded;
    }
    await load('@canlang/b/private');
  ` }).check();
  assert.equal(result.errors.filter(error => error.code === 'unexported-import').length, 1);
  assert.equal(result.unresolved.filter(item => item.kind === 'module').length, 1);
});

test('checks static filesystem/URL sibling reads and allows exported assets', t => {
  const result = fixture(t, { source: `
    import { readFileSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    import { fileURLToPath } from 'node:url';
    const here = dirname(fileURLToPath(import.meta.url));
    readFileSync(join(here, '../../b/src/index.ts'));
    new URL('../../b/src/index.ts', import.meta.url);
    readFileSync(new URL(import.meta.resolve('@canlang/b/asset.txt')));
    readFileSync(join(here, './local.txt'));
  ` }).check();
  assert.equal(result.errors.filter(error => error.code === 'cross-package-path').length, 2);
});

test('checks all local manifest dependency sections and reports dev/runtime cycles', t => {
  const result = fixture(t, { version: '0.1.0', bDependencies: { '@canlang/a': 'workspace:*', '@canlang/missing': 'workspace:*' } }).check();
  assert.ok(result.errors.some(error => error.code === 'workspace-version'));
  assert.ok(result.errors.some(error => error.code === 'unknown-workspace-dependency'));
  assert.ok(result.errors.some(error => error.code === 'dependency-cycle'));
});

test('scans root tests, scripts, CI, and package conformance while ignoring emitted fixtures', t => {
  const f = fixture(t, { declared: false });
  for (const file of ['tests/probe.ts', 'scripts/probe.mjs', '.github/ci/probe.mjs', 'packages/a/conformance/probe.mjs']) f.write(file, "import '@canlang/b';\n");
  f.write('packages/a/dist/probe.js', "import '../../b/src/index.ts';\n");
  const result = f.check();
  assert.equal(result.errors.filter(error => error.code === 'undeclared-dependency').length, 4);
  assert.equal(result.errors.filter(error => error.code === 'cross-package-import').length, 0);
});
