import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { test } from 'node:test';
import { checkoutInputs, checkPackageBoundaries } from './check-package-boundaries.mjs';

function fixture(t, { source = '', declared = true, rootSource, paths, bDependencies, version = 'workspace:*', aExports, packageConsumers, aDependencySections = {}, rootDependencySections = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'can-package-boundaries-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => { const full = path.join(root, file); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, typeof content === 'string' ? content : `${JSON.stringify(content)}\n`); };
  write('package.json', { name: 'fixture', type: 'module', workspaces: ['packages/*'], ...rootDependencySections });
  for (const name of ['a', 'b']) {
    write(`packages/${name}/package.json`, {
      name: `@canlang/${name}`, type: 'module',
      exports: name === 'a' && aExports ? { ...aExports, './asset.txt': './asset.txt' } : { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, './asset.txt': './asset.txt' },
      ...(name === 'a' && declared ? { dependencies: { '@canlang/b': version } } : {}),
      ...(name === 'b' && bDependencies ? { devDependencies: bDependencies } : {}),
      ...(name === 'a' ? aDependencySections : {}),
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
  for (const [name, consumers] of Object.entries(packageConsumers ?? {})) {
    write(`packages/${name}/package.json`, { name: `@canlang/${name}`, type: 'module' });
    write(`packages/${name}/tsconfig.json`, { compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: 'src', outDir: 'dist' }, include: ['src'] });
    for (const [file, content] of Object.entries(consumers)) write(`packages/${name}/${file}`, content);
  }
  if (rootSource) write('tools/probe.mjs', rootSource);
  return { root, write, check: options => checkPackageBoundaries(root, options) };
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

test('rejects production runtime imports satisfied only by local or external development dependencies', t => {
  const result = fixture(t, { declared: false,
    aDependencySections: { devDependencies: { '@canlang/b': 'workspace:*', driver: '1.0.0' } },
    source: `
      import '@canlang/b';
      export * from 'driver';
      const DRIVER = 'driver';
      await import(DRIVER);
      function load(name: string) { return import(name); }
      await load('driver');
    `,
  }).check();
  assert.equal(result.errors.filter(error => error.code === 'production-dev-dependency').length, 4);
  assert.equal(result.errors.filter(error => error.code === 'undeclared-dependency').length, 0);
});

test('allows development dependencies for type-only syntax and contributor source locations', t => {
  const f = fixture(t, { declared: false,
    aDependencySections: { devDependencies: { '@canlang/b': 'workspace:*', driver: '1.0.0' } },
    source: `
      import type { token } from '@canlang/b';
      import { type Driver } from 'driver';
      export type { Driver } from 'driver';
      export { type Driver as Other } from 'driver';
      type Imported = import('driver').Driver;
    `,
  });
  for (const file of ['src/one.test.ts', 'src/two.spec.ts', 'test/helper.ts', 'tests/helper.mjs', '__tests__/helper.ts', 'conformance/helper.mjs', 'scripts/build.mjs']) {
    f.write(`packages/a/${file}`, "import 'driver';\nimport '@canlang/b';\n");
  }
  f.write('packages/a/src/ambient.d.ts', "import { Driver } from 'driver';\nexport declare const driver: Driver;\n");
  f.write('packages/a/src/generated-source.ts', 'export const source = "import \'undeclared-generated-consumer\';";\n');
  assert.deepEqual(f.check().errors, []);
});

test('requires external dependencies on the consuming package even when root declares them', t => {
  const result = fixture(t, {
    rootDependencySections: { devDependencies: { driver: '1.0.0' } },
  });
  result.write('packages/a/test/probe.ts', "import 'driver';\nimport type { Driver } from 'types-only';\n");
  result.write('scripts/probe.mjs', "import 'driver';\nimport 'missing-root-tool';\n");
  assert.deepEqual(result.check().errors.filter(error => error.code === 'undeclared-dependency').map(error => error.file), [
    'packages/a/test/probe.ts', 'packages/a/test/probe.ts', 'scripts/probe.mjs',
  ]);
});

test('allows runtime dependencies, optional dependencies and supplied peers without flagging builtins or package imports', t => {
  const result = fixture(t, { aDependencySections: {
    dependencies: { '@canlang/b': 'workspace:*', runtime: '1.0.0' },
    optionalDependencies: { optional: '1.0.0' }, peerDependencies: { peer: '1.0.0' },
  }, source: "import 'runtime';\nimport 'optional';\nimport 'peer';\nimport 'fs/promises';\nimport 'node:module';\nimport '#own';\n" }).check();
  assert.deepEqual(result.errors, []);
});

test('checks constant require.resolve and createRequire calls, including lazy wrappers', t => {
  const result = fixture(t, { aDependencySections: { devDependencies: { driver: '1.0.0' } }, source: `
    import { createRequire as makeRequire } from 'node:module';
    const require = makeRequire(import.meta.url);
    const DRIVER = 'driver';
    require.resolve(DRIVER);
    makeRequire(import.meta.url).resolve(DRIVER);
    require(DRIVER);
    function resolveDriver(name: string) { return require.resolve(name); }
    resolveDriver(DRIVER);
  ` }).check();
  assert.equal(result.errors.filter(error => error.code === 'production-dev-dependency').length, 4);
});

test('contextual browser locators do not exempt ordinary imports or other consumers', t => {
  const f = fixture(t, { packageConsumers: { testkit: { 'src/browser/chromium.ts': `
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const DRIVER = '@playwright/test';
    require.resolve(DRIVER);
    import '@playwright/test';
  ` } } });
  f.write('packages/testkit/package.json', { name: '@canlang/testkit', type: 'module', devDependencies: { '@playwright/test': '1.63.0' } });
  f.write('packages/a/src/other.ts', "import {createRequire} from 'node:module';\ncreateRequire(import.meta.url).resolve('@playwright/test');\n");
  const result = f.check();
  assert.equal(result.errors.filter(error => error.code === 'production-dev-dependency').length, 1);
  assert.equal(result.errors.filter(error => error.code === 'undeclared-dependency').length, 1);
});

test('dependencies-only mode retains strict dependency errors while leaving full path/export audit separate', t => {
  const f = fixture(t, { aDependencySections: { dependencies: { '@canlang/b': '0.1.0' }, devDependencies: { driver: '1.0.0' } }, source: `
    import 'driver';
    import 'missing-external';
    import '@canlang/b/private';
    import '../../b/src/index.js';
  ` });
  const dependencies = f.check({ dependenciesOnly: true });
  assert.deepEqual(dependencies.errors.map(error => error.code).sort(), [
    'production-dev-dependency', 'undeclared-dependency', 'workspace-version',
  ]);
  const full = f.check();
  assert.ok(full.errors.some(error => error.code === 'cross-package-import'));
  assert.ok(full.errors.some(error => error.code === 'unexported-import'));
  assert.equal(full.errors.length, dependencies.errors.length + 2);
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

test('allows only registered canonical fixture reads from exact consumers', t => {
  const consumers = {
    'test/compiler-check.integration.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join, resolve } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
      readFileSync(join(repo, 'tests/integration/can-dev-server/OfficeSupplies.can'));
    `,
    'test/committed-model-consumer.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join, resolve } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
      readFileSync(join(repo, 'compiler/tests/fixtures/committed_change.can'));
    `,
    'src/runtime/native-local-rules.integration.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join, resolve } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
      readFileSync(join(root, 'compiler/tests/fixtures/hook_order_rollback.can'));
      readFileSync(join(root, 'compiler/tests/fixtures/hook_order_rollback.can'));
    `,
    'src/runtime/native-local-rules-d1.integration.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join, resolve } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
      readFileSync(join(root, 'compiler/tests/fixtures/hook_order_rollback.can'));
      readFileSync(join(root, 'compiler/tests/fixtures/anonymous-message-consumer.mjs'));
      readFileSync(join(root, 'compiler/tests/fixtures/anonymous-message-consumer.mjs'));
      readFileSync(join(root, 'compiler/tests/fixtures/anonymous-message-consumer.mjs'));
    `,
  };
  const f = fixture(t, { packageConsumers: {
    cloudflare: consumers,
    state: { 'test/file-retirement-storage.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const root = fileURLToPath(new URL('../../../', import.meta.url));
      readFileSync(join(root, 'packages/cloudflare/test/fixtures/typed-images-progress.can'));
    ` },
    work: { 'test/file-retirement-framework.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const root = fileURLToPath(new URL('../../../', import.meta.url));
      readFileSync(join(root, 'packages/cloudflare/test/fixtures/typed-images-progress.can'));
    ` },
  } });
  const result = f.check();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.registered.map(entry => entry.consumer).sort(), [
    'packages/cloudflare/src/runtime/native-local-rules-d1.integration.test.ts',
    'packages/cloudflare/src/runtime/native-local-rules-d1.integration.test.ts',
    'packages/cloudflare/src/runtime/native-local-rules-d1.integration.test.ts',
    'packages/cloudflare/src/runtime/native-local-rules-d1.integration.test.ts',
    'packages/cloudflare/src/runtime/native-local-rules.integration.test.ts',
    'packages/cloudflare/src/runtime/native-local-rules.integration.test.ts',
    'packages/cloudflare/test/committed-model-consumer.test.ts',
    'packages/cloudflare/test/compiler-check.integration.test.ts',
    'packages/state/test/file-retirement-storage.test.ts',
    'packages/work/test/file-retirement-framework.test.ts',
  ]);
});

test('registers only the exact composed owner-policy Compiler input', t => {
  const source = target => `
    import { readFile } from 'node:fs/promises';
    import { join, resolve } from 'node:path';
    import { fileURLToPath } from 'node:url';
    const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
    await readFile(join(root, '${target}'), 'utf8');
  `;
  const f = fixture(t, { packageConsumers: { cloudflare: {
    'test/composed-owner-policy.test.ts': source('compiler/tests/model_rule_origins.rs'),
  } } });
  const accepted = f.check();
  assert.deepEqual(accepted.errors, []);
  assert.deepEqual(accepted.registered.map(({ consumer, target }) => ({ consumer, target })), [{
    consumer: 'packages/cloudflare/test/composed-owner-policy.test.ts', target: 'compiler/tests/model_rule_origins.rs',
  }]);
  f.write('packages/cloudflare/test/composed-owner-policy.test.ts',
    source('compiler/tests/another.rs') + "import '../../a/src/index.js';\n");
  f.write('packages/cloudflare/test/other.test.ts', source('compiler/tests/model_rule_origins.rs'));
  const refused = f.check();
  assert.equal(refused.errors.filter(error => error.code === 'cross-package-path').length, 2);
  assert.equal(refused.errors.filter(error => error.code === 'cross-package-import').length, 1);
  assert.deepEqual(refused.registered, []);
});

test('rejects other fixture reads and cross-package source imports from exact consumers', t => {
  const f = fixture(t, { packageConsumers: { cloudflare: {
    'test/compiler-check.integration.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join, resolve } from 'node:path';
      import { fileURLToPath } from 'node:url';
      import '../../a/src/index.js';
      const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
      readFileSync(join(repo, 'tests/integration/can-dev-server/Another.can'));
      readFileSync(join(repo, 'compiler/tests/fixtures/hook_order_rollback.can'));
      readFileSync(join(repo, 'compiler/tests/fixtures/anonymous-message-consumer.mjs'));
    `,
    'test/committed-model-consumer.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join, resolve } from 'node:path';
      import { fileURLToPath } from 'node:url';
      import '../../a/src/index.js';
      const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
      readFileSync(join(repo, 'compiler/tests/fixtures/Another.can'));
    `,
    'src/runtime/native-local-rules.integration.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join, resolve } from 'node:path';
      import { fileURLToPath } from 'node:url';
      import '../../../a/src/index.js';
      const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
      readFileSync(join(root, 'compiler/tests/fixtures/Another.can'));
      readFileSync(join(root, 'compiler/tests/fixtures/anonymous-message-consumer.mjs'));
    `,
    'src/runtime/native-local-rules-d1.integration.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join, resolve } from 'node:path';
      import { fileURLToPath } from 'node:url';
      import '../../../a/src/index.js';
      import '../../../../compiler/tests/fixtures/anonymous-message-consumer.mjs';
      const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
      readFileSync(join(root, 'compiler/tests/fixtures/Another.can'));
      readFileSync(join(root, 'compiler/tests/fixtures/Another.mjs'));
    `,
  }, state: {
    'test/file-retirement-storage.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { fileURLToPath } from 'node:url';
      import '../../cloudflare/src/index.js';
      import '../../cloudflare/test/fixtures/typed-images-progress.can';
      const root = fileURLToPath(new URL('../../../', import.meta.url));
      readFileSync(join(root, 'packages/cloudflare/test/fixtures/another.can'));
    `,
    'test/other.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const root = fileURLToPath(new URL('../../../', import.meta.url));
      readFileSync(join(root, 'packages/cloudflare/test/fixtures/typed-images-progress.can'));
    `,
  }, work: {
    'test/file-retirement-framework.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { fileURLToPath } from 'node:url';
      import '../../cloudflare/src/index.js';
      await import('../../cloudflare/test/fixtures/typed-images-progress.can');
      const root = fileURLToPath(new URL('../../../', import.meta.url));
      readFileSync(join(root, 'packages/cloudflare/test/fixtures/another.can'));
    `,
    'test/other.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const root = fileURLToPath(new URL('../../../', import.meta.url));
      readFileSync(join(root, 'packages/cloudflare/test/fixtures/typed-images-progress.can'));
    `,
  } } });
  const result = f.check();
  assert.equal(result.errors.filter(error => error.code === 'cross-package-path').length, 12);
  assert.equal(result.errors.filter(error => error.code === 'cross-package-import').length, 9);
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
