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
import { dirname, isAbsolute, join, relative } from 'node:path';
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
    modules: [{ path: 'app/main.js', js: 'import { renderPage } from "@canlang/ui";\nimport { abs } from "@canlang/stdlib";\nif (abs(-2n) !== 2n) throw new Error("installed Worker abs producer returned an incorrect result");\nexport const appDefinition = { id: "installed" };\nexport const descriptor = { owner: "installed", path: "/main", admit: async () => ({ ok: true }), render: async () => ({ status: 200 }), renderPage, abs };\n', map: { version: 3, file: 'app.can', sources: [], sourcesContent: [], names: [], mappings: '' } }],
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
  assert.match(first.modules[api.HTTP_OPERATIONS_MODULE], /\bexport\s*\{[^}]*\breceiverFromIdentity\b[^}]*\}/s, 'the genuine HTTP bundle must expose the receiving principal named export');
  assert.match(first.modules['runtime/invoke.js'], /^\s*import\s*\{\s*receiverFromIdentity\s*\}\s*from\s*['"]\.\.\/worker\/http-operations\.js['"]/m, 'the current owning runtime must consume the genuine HTTP principal export');
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

  // The public Work producer and its real relative cycle must survive packing.
  // Optional State observer absence remains distinct from this present producer.
  const workReceiptEntry = ownerModule('@canlang/work/receipt');
  const workReceipt = await import(workReceiptEntry);
  const workObservation = await import(ownerModule('@canlang/work/observation/observation'));
  const workAssociation = await import(ownerModule('@canlang/work/observation/association'));
  const workFns = await workReceipt.loadWorkReceiptFns();
  assert.equal(workFns.observeSelectedReceipt, workObservation.observeSelectedReceipt);
  assert.equal(workFns.applyReceiptProgress, workAssociation.applyReceiptProgress);
  assert.equal(workFns.isConsistentCompletion, workReceipt.isConsistentCompletion);
  const workClosure = ['vendor/work/receipt/index.js', 'vendor/work/observation/observation.js', 'vendor/work/observation/association.js'];
  for (const key of workClosure) {
    assert.ok(first.modules[key], key);
    const missing = { ...first.modules }; delete missing[key];
    assert.throws(() => api.assertLinksResolve(missing), /no such staged module/, `missing ${key}`);
  }
  assert.ok(first.modules['runtime/invoke.js'].includes('../vendor/work/receipt/index.js'));
  assert.ok(!first.modules['runtime/invoke.js'].includes('@canlang/work/receipt'));
  api.assertLinksResolve(first.modules); api.assertWorkerdLoadable(first.modules);

  const filesClosure = ['vendor/files/finalize/index.js', 'vendor/files/upload/index.js', 'vendor/files/provenance/index.js', 'vendor/files/ports.js'];
  assert.deepEqual(Object.keys(first.modules).filter(key => key.startsWith('vendor/files/')).sort(), [...filesClosure].sort());
  const stateFiles = first.modules['vendor/state/invocation/scenario-file-assignment.js'];
  assert.ok(stateFiles.includes('../../files/finalize/index.js'));
  assert.ok(stateFiles.includes('../../files/ports.js'));
  assert.ok(!stateFiles.includes('@canlang/files/finalize'));
  assert.ok(!stateFiles.includes('@canlang/files/ports'));
  // Require the actual portable finalizer explicitly in this link control,
  // as the workerd probe does below, alongside the genuine State consumer.
  const filesLinkControl = 'export { readFinalizedFileObservation } from "./vendor/files/finalize/index.js";';
  for (const key of filesClosure) {
    const missing = { ...first.modules, 'installed-files-link-control.js': filesLinkControl }; delete missing[key];
    assert.throws(() => api.assertLinksResolve(missing), /no such staged module/, `missing ${key}`);
  }
  const filesFinalizeEntry = ownerModule('@canlang/files/finalize');
  const filesFinalize = await import(filesFinalizeEntry);
  assert.equal(filesFinalize.readFinalizedFileObservation({}), null, 'raw data supplies no live Files identity');
  assert.ok(first.modules['vendor/files/upload/index.js'].includes('../../noble-hashes/sha2.js'));
  assert.ok(first.modules['vendor/files/upload/index.js'].includes('../../noble-hashes/utils.js'));

  // Require selects Acorn's CJS root. The pinned public manifest names the
  // actual import-condition ESM producer used by the portable Worker.
  const acornManifestFile = fileURLToPath(ownerModule('acorn/package.json'));
  const acornManifest = JSON.parse(readFileSync(acornManifestFile, 'utf8'));
  assert.equal(acornManifest.name, 'acorn');
  assert.equal(acornManifest.version, '8.18.0');
  assert.equal(acornManifest.module, 'dist/acorn.mjs');
  assert.equal(acornManifest.exports['.'][0].import, './dist/acorn.mjs');
  const acornFile = installedFile(pathToFileURL(join(dirname(acornManifestFile), acornManifest.module)));
  const acornKey = 'vendor/acorn/acorn.js';
  assert.deepEqual(Object.keys(first.modules).filter(key => key.startsWith('vendor/acorn/')), [acornKey]);
  assert.equal(first.modules[acornKey], readFileSync(acornFile, 'utf8'));
  const missingAcorn = { ...first.modules, 'installed-acorn-link-control.js': `export { parse } from ${JSON.stringify('./' + acornKey)};` };
  delete missingAcorn[acornKey];
  assert.throws(() => api.assertLinksResolve(missingAcorn), /no such staged module/, 'missing actual Acorn ESM key');

  // Reuse the actual serving control at a new installed location. This child
  // cannot read checkout source and exercises the uninjected Node fallback
  // through genuine Identity, State receipt rows and the public Work producer.
  const invokeEntry = ownerModule('@canlang/cloudflare/runtime/invoke');
  const servingControl = join(dirname(fileURLToPath(invokeEntry)), 'd3b-observer-seam.test.js');
  installedFile(pathToFileURL(servingControl));
  // Execute the exact control directly: node:test honors the pattern without
  // CLI file discovery or test-runner child isolation outside this permission.
  execFileSync(process.execPath, ['--permission', `--allow-fs-read=${process.env.TMPDIR}`, `--allow-fs-write=${process.env.TMPDIR}`,
    '--test-name-pattern=serves deep-equal output', servingControl],
  { cwd: consumer, env: process.env, stdio: 'inherit' });

  // Stale direct-emission residue in isolated installed copies must not enter
  // the Worker map. Production bytes are untouched, and exclusions stay live.
  const staleFiles = [
    new URL('fanout/work-loader.js', distributions.state.modules),
    new URL('receipt/work-loader.js', distributions.state.modules),
    new URL('receipt/stale.test.js', distributions.state.modules),
    new URL('sessions/comparison-node.js', distributions.identity.modules),
    new URL('stale-node-only.js', new URL('../observation/', workReceiptEntry)),
    new URL('stale.test.js', new URL('../observation/', workReceiptEntry)),
    new URL('../host/stale.js', filesFinalizeEntry),
    new URL('../upload/stale-node-only.js', filesFinalizeEntry),
    new URL('stale.test.js', filesFinalizeEntry),
  ].map(fileURLToPath);
  const staleSaved = staleFiles.map(file => existsSync(file) ? readFileSync(file) : null);
  try {
    for (const file of staleFiles) {
      assert.ok(inside(file, consumer)); mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'import { readFileSync } from "node:fs"; export { readFileSync };\n');
    }
    const stale = api.buildDeployBundle(artifact, { verdict: options.verdict });
    assert.deepEqual(stale, plain, 'stale excluded bytes cannot change the ordinary bundle');
    api.assertLinksResolve(stale.modules); api.assertWorkerdLoadable(stale.modules);
  } finally {
    for (let index = 0; index < staleFiles.length; index++) {
      const saved = staleSaved[index];
      if (saved === null) rmSync(staleFiles[index]); else writeFileSync(staleFiles[index], saved);
    }
  }

  // Mutate only isolated producer files, never the checkout's shared outputs.
  const producerFiles = ['@canlang/work/receipt', '@canlang/work/observation/observation', '@canlang/work/observation/association',
    '@canlang/files/finalize', '@canlang/files/upload', '@canlang/files/provenance', '@canlang/files/ports']
    .map(specifier => [specifier, fileURLToPath(ownerModule(specifier))]);
  producerFiles.push(['acorn ESM', acornFile]);
  for (const [specifier, file] of producerFiles) {
    const saved = readFileSync(file);
    try {
      rmSync(file);
      assert.throws(() => api.buildDeployBundle(artifact, { verdict: options.verdict }),
        error => {
          const absent = error.code === 'ENOENT' ? error : error.cause;
          return absent?.code === 'ENOENT' && absent.path === file && /not built|ENOENT/.test(error.message);
        }, `missing real ${specifier}`);
    } finally { writeFileSync(file, saved); }
  }

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
  // backend, and rewritten producer graph, plus the genuine portable Files
  // digest/strict decoder, nongrant extractor, and pinned Acorn parser. The
  // probe supplies its entry; parsing must not execute the source initializer.
  const backendKey = Object.keys(first.modules).find(key => key.endsWith('/values-bindings/backend.js'));
  assert.ok(backendKey, 'selected values backend must be staged');
  const probeKey = 'installed-wasm-probe.js';
  const parserSource = 'export const marker = {"\\u0070olicy": false}; throw new Error("initializer");';
  const probeSource = [
    `import compiled from ${JSON.stringify('./' + wasmKey)};`,
    `import * as glue from ${JSON.stringify('./' + glueKey)};`,
    `import { wasmBackend } from ${JSON.stringify('./' + backendKey)};`,
    'import { sha256Hex, checkContent } from "./vendor/files/upload/index.js";',
    'import { readFinalizedFileObservation } from "./vendor/files/finalize/index.js";',
    `import { parse, version } from ${JSON.stringify('./' + acornKey)};`,
    'glue.initSync({ module: compiled });',
    'const backend = wasmBackend(glue);',
    `const ast = parse(${JSON.stringify(parserSource)}, { ecmaVersion: 'latest', sourceType: 'module' });`,
    'let malformedRejected = false; try { parse("export const =", { ecmaVersion: "latest", sourceType: "module" }); } catch (error) { malformedRejected = error instanceof SyntaxError; }',
    'const acorn = { version, declaration: ast.body[0].type, escapedKey: ast.body[0].declaration.declarations[0].init.properties[0].key.value, trailing: ast.body[1].type, malformedRejected };',
    'export default { fetch() { const bytes = new Uint8Array([0x99, 0x00, 0xff, 0x80, 0x01, 0x77]).subarray(1, 5); return Response.json({ compiled: compiled instanceof WebAssembly.Module, abi: glue.abi_version(), sum: String(backend.call("add-int", [1n, 2n])), acorn, files: { slicedDigest: sha256Hex(bytes), pdf: checkContent({ types: ["application/pdf"], maxBytes: 64 }, "text/plain", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), invalidText: checkContent({ types: ["text/plain"], maxBytes: 64 }, "text/plain", new Uint8Array([0xc3, 0x28])), rawObservation: readFinalizedFileObservation({}) } }); } };',
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
    assert.deepEqual(wasmWorkerResult, { compiled: true, abi: REQUIRED_ABI_VERSION, sum: '3', acorn: {
      version: '8.18.0', declaration: 'ExportNamedDeclaration', escapedKey: 'policy', trailing: 'ThrowStatement', malformedRejected: true,
    }, files: {
      slicedDigest: `sha256:${digest(new Uint8Array([0x00, 0xff, 0x80, 0x01]))}`,
      pdf: { claimedType: 'text/plain', detectedType: 'application/pdf', sizeBytes: 5, verdict: 'accepted' },
      invalidText: { claimedType: 'text/plain', detectedType: null, sizeBytes: 2, verdict: 'rejected' },
      rawObservation: null,
    } });
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
  const evidence = { node: process.version, checkoutRead: 'ERR_ACCESS_DENIED', bunPermissionLimit: 'Bun and workerd subprocesses do not inherit Node filesystem permissions; resolved producer entries and emitted runtime bytes are checked.', directDependencies: Object.keys(manifest.dependencies), linker: 'isolated', installConfiguration, directPackageBindings, ownerEntryRealpath: fileURLToPath(ownerEntry), ownerResolutions, installedLocations: locations, esmCondition: 'import.js', workerModules: first.moduleCount, productionWorker: { initializeStatus: 401, body: productionBody }, wasm: { key: wasmKey, bytes: first.binaries[wasmKey].length, sha256: digest(first.binaries[wasmKey]), compiledModule: 'ABI accepted; add-int(1,2)=3', workerd: wasmWorkerResult }, browser: Object.fromEntries(Object.entries(first.resources).map(([key, resource]) => [key, { bytes: resource.bytes.length, sha256: digest(resource.bytes), contentType: resource.contentType }])), negativeCases, observer: { optionalState: 'exact absent module remains fail-closed', work: 'genuine public functions and uninjected installed Node serving passed', workClosure, staleResidue: 'unchanged ordinary bundle', missingProducers: 3 }, files: { closure: filesClosure, missingProducers: 4, stateImports: 'actual scenario-file-assignment finalizer and ports edges', portableWorkerd: wasmWorkerResult.files, authority: 'Portable producer primitives only; no State/native workflow acceptance' }, acorn: { key: acornKey, publicEntry: acornManifest.module, missingProducers: 1, portableWorkerd: wasmWorkerResult.acorn, authority: 'Parser staging and execution only; Dev owns source verification and current G1' } };
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
