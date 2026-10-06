#!/usr/bin/env node
/**
 * Real tarball regression for the installed Worker build and asset inventory.
 * Run with Node 24 and Bun on PATH; --skip-build uses already built packages.
 * The verification child cannot read the checkout. Bun/workerd subprocesses
 * do not inherit Node permissions, so producer entry realpaths and emitted
 * bytes are checked separately. No workspace links or testkit are installed.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (file, directory) => {
  const path = relative(directory, file);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
};

async function verifyConsumer(checkout) {
  const consumer = realpathSync(process.cwd());
  assert.throws(() => readFileSync(join(checkout, 'package.json')), error => error.code === 'ERR_ACCESS_DENIED', 'checkout reads must be denied');
  const manifest = JSON.parse(readFileSync(join(consumer, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies), ['@canlang/cloudflare']);
  assert.equal(existsSync(join(consumer, 'node_modules/@canlang/testkit')), false);
  const installConfiguration = readFileSync(join(consumer, 'bunfig.toml'), 'utf8');
  assert.equal(installConfiguration, '[install]\nlinker = "isolated"\n');
  const directPackageBindings = readdirSync(join(consumer, 'node_modules/@canlang')).sort();
  assert.deepEqual(directPackageBindings, ['cloudflare'], 'Transitive packages must not acquire consumer-root bindings');
  const locations = [];
  function installedFile(url) {
    const file = realpathSync(fileURLToPath(url));
    assert.ok(inside(file, consumer), `producer escapes installed consumer: ${file}`);
    assert.ok(!inside(file, checkout));
    locations.push(relative(consumer, file));
    return file;
  }
  const ownerEntry = pathToFileURL(installedFile(import.meta.resolve('@canlang/cloudflare/deploy/bundle')));
  assert.ok(inside(fileURLToPath(ownerEntry), join(consumer, 'node_modules/.bun')), 'Installed owner must use Bun isolated storage');
  const ownerRequire = createRequire(ownerEntry);
  const ownerResolutions = {};
  // The consumer declares only Cloudflare. Its transitive proof modules resolve
  // from that installed owner's context, just as the owning bundler does.
  function ownerModule(specifier) {
    const url = pathToFileURL(ownerRequire.resolve(specifier));
    const file = installedFile(url);
    ownerResolutions[specifier] = file;
    return pathToFileURL(file);
  }
  for (const specifier of ['@canlang/cloudflare/worker', '@canlang/cloudflare/worker/main', '@canlang/cloudflare/runtime/mcp-registry', '@canlang/interfaces/mcp/server', '@canlang/interfaces/http/operations']) {
    ownerModule(specifier);
  }
  const distributions = {};
  for (const name of ['contracts', 'ui', 'identity', 'stdlib', 'state', 'values']) {
    distributions[name] = (await import(ownerModule(`@canlang/${name}/distribution`))).distribution;
    installedFile(distributions[name].modules);
  }
  installedFile(distributions.values.bindings);
  installedFile(distributions.ui.browser);

  // A conditional producer exposes different import and require entries. The
  // installed bundler helper must select the ESM entry used by its generated JS.
  const fixture = join(consumer, 'node_modules/conditional-worker-producer');
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'conditional-worker-producer', type: 'module', exports: { '.': { import: './import.js', require: './require.js' } } }));
  for (const name of ['import', 'require']) writeFileSync(join(fixture, `${name}.js`), `export const condition = ${JSON.stringify(name)};\n`);
  installedFile(import.meta.resolve('@canlang/cloudflare/deploy/bundle'));
  installedFile(import.meta.resolve('@canlang/cloudflare/deploy/producer-files'));
  const { resolveProducerFile } = await import('@canlang/cloudflare/deploy/producer-files');
  assert.equal(resolveProducerFile('conditional-worker-producer', 'fixture build'), join(fixture, 'import.js'));

  const api = await import('@canlang/cloudflare/deploy/bundle');
  const artifact = {
    artifact_version: 1, language_version: '1.0.0', tool_version: '0.1.0',
    sources: [{ path: 'app.can', sha256: '0'.repeat(64) }],
    modules: [{ path: 'app/main.js', js: 'import { renderPage } from "@canlang/ui";\nimport { abs } from "@canlang/stdlib";\nexport const descriptor = { owner: "installed", path: "/main", admit: async () => ({ ok: true }), render: async () => ({ status: 200 }), renderPage, abs };\n', map: { version: 3, file: 'app.can', sources: [], sourcesContent: [], names: [], mappings: '' } }],
    callables: [], operations: [], pages: [{ owner: 'installed', path: '/main', module: 'app/main.js', export: 'descriptor' }], requires: [], tests: [],
  };
  const options = { verdict: { active: true }, assets: { valuesWasm: true, browser: true } };
  const plain = api.buildDeployBundle(artifact, { verdict: options.verdict });
  const first = api.buildDeployBundleWithAssets(artifact, options);
  const second = api.buildDeployBundleWithAssets(artifact, options);
  assert.deepEqual(first, second, 'installed Worker and asset bytes must be deterministic');
  assert.equal(first.modules['vendor/state/receipt/observer.js'], undefined);
  assert.ok(!Object.keys(first.modules).some(key => key.endsWith('/work-loader.js')));
  assert.ok(plain.modules && !Object.keys(plain.modules).some(key => key.endsWith('values_semantics.js')), 'values backend remains opt-in');
  for (const marker of api.MCP_BUNDLE_MARKERS) assert.ok(first.modules[api.MCP_HANDLER_MODULE].includes(marker));
  for (const marker of api.HTTP_BUNDLE_MARKERS) assert.ok(first.modules[api.HTTP_OPERATIONS_MODULE].includes(marker));
  for (const [key, source] of Object.entries(first.modules)) {
    assert.ok(!source.includes(checkout), `runtime module contains checkout path: ${key}`);
    assert.ok(!source.includes('/packages/'), `runtime module contains sibling package path: ${key}`);
  }
  const wasmKey = Object.keys(first.binaries).find(key => key.endsWith('/values_semantics_bg.wasm'));
  const glueKey = Object.keys(first.modules).find(key => key.endsWith('/values_semantics.js'));
  assert.ok(wasmKey && glueKey, 'opt-in values glue and binary must be staged');
  const installedWasm = installedFile(ownerModule('@canlang/values/bindings/generated/values_semantics_bg.wasm'));
  assert.equal(digest(first.binaries[wasmKey]), digest(readFileSync(installedWasm)));
  assert.deepEqual(Object.keys(first.resources).sort(), ['browser/bootstrap.js', 'browser/can-style.css', 'browser/polling.js']);
  for (const [key, resource] of Object.entries(first.resources)) {
    assert.ok(resource.bytes instanceof Uint8Array && resource.bytes.length > 0, key);
    assert.ok(resource.contentType.includes(key.endsWith('.css') ? 'css' : 'javascript'), key);
    assert.equal(first.modules[key], undefined, 'browser bytes must stay outside Worker modules');
    assert.equal(digest(resource.bytes), digest(readFileSync(new URL(key.slice('browser/'.length), distributions.ui.browser))));
  }
  const output = join(consumer, 'worker-output');
  api.writeDeployBundleWithAssets(first, output);
  for (const [key, source] of Object.entries(first.modules)) assert.equal(readFileSync(join(output, key), 'utf8'), source);
  assert.equal(digest(readFileSync(join(output, wasmKey))), digest(first.binaries[wasmKey]));
  for (const [key, resource] of Object.entries(first.resources)) assert.equal(digest(readFileSync(join(output, key))), digest(resource.bytes));
  const glue = await import(pathToFileURL(join(output, glueKey)));
  glue.initSync({ module: new WebAssembly.Module(readFileSync(join(output, wasmKey))) });
  const { REQUIRED_ABI_VERSION, wasmBackend } = await import(ownerModule('@canlang/values/bindings/backend'));
  assert.equal(glue.abi_version(), REQUIRED_ABI_VERSION);
  assert.equal(wasmBackend(glue).call('add-int', [1n, 2n]), 3n);
  const receipt = await import(ownerModule('@canlang/state/receipt'));
  await assert.rejects(receipt.loadReceiptObserver(), error => error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes(fileURLToPath(receipt.receiptObserverModuleUrl)));

  // Boot the actual installed production entry, including its assembly and D1
  // producer graph. A credential-free initialize request reaches the auth seam.
  installedFile(import.meta.resolve('@canlang/cloudflare/dev/local-run'));
  const { startLocalDev } = await import('@canlang/cloudflare/dev/local-run');
  const production = await startLocalDev({
    workerName: 'installed-worker-regression', compatibilityDate: '2026-07-15',
    mainModule: first.mainModule, modules: first.modules, binaryModules: first.binaries,
    d1Databases: [{ binding: 'DB', id: 'installed-worker-regression' }],
  });
  let productionBody;
  try {
    const response = await production.dispatch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    productionBody = await response.text();
    assert.equal(response.status, 401, productionBody);
    assert.ok(!/assembly-(?:failed|failure)/i.test(productionBody));
  } finally {
    await production.dispose();
  }

  // Exercise CompiledWasm in workerd, using the actual selected binary, glue,
  // backend, and rewritten producer graph. The probe only supplies its entry.
  const backendKey = Object.keys(first.modules).find(key => key.endsWith('/values-bindings/backend.js'));
  assert.ok(backendKey, 'selected values backend must be staged');
  const probeKey = 'installed-wasm-probe.js';
  const probeSource = [
    `import compiled from ${JSON.stringify('./' + wasmKey)};`,
    `import * as glue from ${JSON.stringify('./' + glueKey)};`,
    `import { wasmBackend } from ${JSON.stringify('./' + backendKey)};`,
    'glue.initSync({ module: compiled });',
    'const backend = wasmBackend(glue);',
    'export default { fetch() { return Response.json({ compiled: compiled instanceof WebAssembly.Module, abi: glue.abi_version(), sum: String(backend.call("add-int", [1n, 2n])) }); } };',
  ].join('\n');
  const wasmWorker = await startLocalDev({
    workerName: 'installed-wasm-regression', compatibilityDate: '2026-07-15',
    mainModule: probeKey, modules: { ...first.modules, [probeKey]: probeSource }, binaryModules: first.binaries,
  });
  let wasmWorkerResult;
  try {
    const response = await wasmWorker.dispatch('/');
    assert.equal(response.status, 200);
    wasmWorkerResult = await response.json();
    assert.deepEqual(wasmWorkerResult, { compiled: true, abi: REQUIRED_ABI_VERSION, sum: '3' });
  } finally {
    await wasmWorker.dispose();
  }

  // Mutate only installed scratch copies. Default Worker builds remain usable;
  // opted-in inventory must reject missing/corrupt producer bytes explicitly.
  const negativeCases = [];
  for (const [file, name] of [
    [fileURLToPath(new URL('generated/values_semantics_bg.wasm', distributions.values.bindings)), 'values_semantics_bg.wasm'],
    [fileURLToPath(new URL('can-style.css', distributions.ui.browser)), 'can-style.css'],
  ]) {
    const saved = readFileSync(file);
    try {
      rmSync(file);
      api.buildDeployBundle(artifact, { verdict: options.verdict });
      assert.throws(() => api.buildDeployBundleWithAssets(artifact, options), error => error.message.includes(name), `missing ${name} must fail closed`);
      negativeCases.push(`missing ${name}`);
      const corrupt = Buffer.from(saved);
      corrupt[0] ^= 1;
      writeFileSync(file, corrupt);
      assert.throws(() => api.buildDeployBundleWithAssets(artifact, options), error => error.message.includes(name) && /integrity|digest|hash|mismatch/i.test(error.message), `corrupt ${name} must fail closed`);
      negativeCases.push(`corrupt ${name}`);
    } finally {
      writeFileSync(file, saved);
    }
  }
  const evidence = { node: process.version, checkoutRead: 'ERR_ACCESS_DENIED', bunPermissionLimit: 'Bun and workerd subprocesses do not inherit Node filesystem permissions; resolved producer entries and emitted runtime bytes are checked.', directDependencies: Object.keys(manifest.dependencies), linker: 'isolated', installConfiguration, directPackageBindings, ownerEntryRealpath: fileURLToPath(ownerEntry), ownerResolutions, installedLocations: locations, esmCondition: 'import.js', workerModules: first.moduleCount, productionWorker: { initializeStatus: 401, body: productionBody }, wasm: { key: wasmKey, bytes: first.binaries[wasmKey].length, sha256: digest(first.binaries[wasmKey]), compiledModule: 'ABI accepted; add-int(1,2)=3', workerd: wasmWorkerResult }, browser: Object.fromEntries(Object.entries(first.resources).map(([key, resource]) => [key, { bytes: resource.bytes.length, sha256: digest(resource.bytes), contentType: resource.contentType }])), negativeCases, observer: 'exact missing producer remains fail-closed' };
  writeFileSync(join(consumer, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
}

if (process.argv[2] === '--consumer') {
  await verifyConsumer(process.argv[3]);
} else {
  const checkout = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node 24 or newer for the filesystem permission regression');
  if (!process.argv.includes('--skip-build')) execFileSync('bun', ['run', 'build'], { cwd: checkout, stdio: 'inherit' });
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'canlang-installed-worker-'));
  const consumer = join(scratch, 'consumer');
  const tarballs = join(scratch, 'tarballs');
  mkdirSync(consumer); mkdirSync(tarballs);
  const packages = new Map(readdirSync(join(checkout, 'packages'), { withFileTypes: true }).filter(item => item.isDirectory()).map(item => {
    const directory = join(checkout, 'packages', item.name);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    return [manifest.name, { directory, manifest }];
  }));
  const needed = new Set();
  function add(name) {
    if (needed.has(name)) return;
    const producer = packages.get(name);
    assert.ok(producer, `missing local producer ${name}`);
    needed.add(name);
    for (const dependency of Object.keys(producer.manifest.dependencies ?? {})) if (dependency.startsWith('@canlang/')) add(dependency);
  }
  add('@canlang/cloudflare');
  const overrides = {};
  for (const name of [...needed].sort()) {
    const file = join(tarballs, `${name.slice('@canlang/'.length)}.tgz`);
    execFileSync('bun', ['pm', 'pack', '--ignore-scripts', '--filename', file, '--quiet'], { cwd: packages.get(name).directory, stdio: 'pipe' });
    overrides[name] = `file:${file}`;
  }
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'canlang-installed-worker-regression', private: true, type: 'module', dependencies: { '@canlang/cloudflare': overrides['@canlang/cloudflare'] }, overrides }, null, 2) + '\n');
  writeFileSync(join(consumer, 'bunfig.toml'), '[install]\nlinker = "isolated"\n');
  execFileSync('bun', ['install', '--ignore-scripts'], { cwd: consumer, env: { ...process.env, TMPDIR: scratch }, stdio: 'inherit' });
  const script = join(consumer, 'verify.mjs');
  copyFileSync(fileURLToPath(import.meta.url), script);
  execFileSync(process.execPath, ['--permission', `--allow-fs-read=${scratch}`, `--allow-fs-write=${scratch}`, '--allow-child-process', script, '--consumer', checkout], { cwd: consumer, env: { ...process.env, TMPDIR: scratch }, stdio: 'inherit' });
  console.log(`Installed Worker verification passed. Evidence: ${join(consumer, 'evidence.json')}`);
}
