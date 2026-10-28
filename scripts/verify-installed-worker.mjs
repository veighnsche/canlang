#!/usr/bin/env node
/**
 * Real tarball regression for the installed Worker build and asset inventory.
 * Run with Node 24 and Bun on PATH; --skip-build uses already built packages.
 * --minimum-node22 selects exactly Node22.0.0 with its permission flag.
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
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const minimumNode22 = process.argv.includes('--minimum-node22');
if (minimumNode22) assert.equal(process.version, 'v22.0.0', 'Minimum-engine qualification requires exactly Node22.0.0');
const permissionFlag = minimumNode22 ? '--experimental-permission' : '--permission';
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
  function installedFile(url) {
    const file = realpathSync(fileURLToPath(url));
    assert.ok(inside(file, consumer), `producer escapes installed consumer: ${file}`);
    assert.ok(!inside(file, checkout));
    return file;
  }
  const ownerEntry = pathToFileURL(installedFile(import.meta.resolve('@canlang/cloudflare/deploy/bundle')));
  assert.ok(inside(fileURLToPath(ownerEntry), join(consumer, 'node_modules/.bun')), 'Installed owner must use Bun isolated storage');
  const ownerRequire = createRequire(ownerEntry);
  // The consumer declares only Cloudflare. Its transitive proof modules resolve
  // from that installed owner's context, just as the owning bundler does.
  function ownerModule(specifier) {
    const url = pathToFileURL(ownerRequire.resolve(specifier));
    const file = installedFile(url);
    return pathToFileURL(file);
  }
  for (const specifier of ['@canlang/cloudflare/worker', '@canlang/cloudflare/worker/main', '@canlang/cloudflare/runtime/mcp-registry', '@canlang/interfaces/mcp/server', '@canlang/interfaces/http/operations']) {
    ownerModule(specifier);
  }
  const distributions = {};
  for (const name of ['contracts', 'ui', 'identity', 'stdlib', 'state', 'work', 'values']) {
    distributions[name] = (await import(ownerModule(`@canlang/${name}/distribution`))).distribution;
    installedFile(distributions[name].modules);
  }
  installedFile(distributions.values.bindings);
  installedFile(distributions.ui.browser);

  const nativeDistribution = (await import(ownerModule('@canlang/cloudflare/distribution'))).distribution;
  const nativeCatalog = JSON.parse(readFileSync(installedFile(nativeDistribution.nativeCatalog), 'utf8'));
  const { CATALOG } = await import(ownerModule('@canlang/values'));
  const membership = CATALOG.entries.filter(entry => entry.kind === 'builtin' && entry.id === 'active_member');
  assert.equal(membership.length, 1);
  assert.equal(membership[0].availability, 'external');
  assert.equal(membership[0].effects, 'state-read');
  assert.deepEqual(nativeCatalog, { ...CATALOG, entries: CATALOG.entries.map(entry =>
    entry === membership[0] ? { ...entry, availability: 'implemented' } : entry) });
  const nativeStdlibUrl = ownerModule('@canlang/cloudflare/runtime/stdlib');
  const nativeStdlib = await import(nativeStdlibUrl);
  const nativeMembership = await import(pathToFileURL(installedFile(new URL('./native-membership.js', nativeStdlibUrl))));
  const nativeExport = Object.getOwnPropertyDescriptor(nativeStdlib, 'active_member');
  const nativeOriginal = Object.getOwnPropertyDescriptor(nativeMembership, 'active_member');
  assert.ok(nativeExport && 'value' in nativeExport && typeof nativeExport.value === 'function');
  assert.ok(nativeOriginal && 'value' in nativeOriginal && nativeExport.value === nativeOriginal.value);

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
    modules: [{ path: 'app/main.js', js: 'import { renderPage } from "@canlang/ui";\nimport { abs } from "@canlang/stdlib";\nif (abs(-2n) !== 2n) throw new Error("installed Worker abs producer returned an incorrect result");\nexport const appDefinition = { id: "installed", runtimeBindingOwners: ["installed"], packages: { installed: { roles: {} } } };\nexport const descriptor = { owner: "installed", path: "/main", admit: async () => ({ ok: true }), render: async () => ({ status: 200 }), renderPage, abs };\n', map: { version: 3, file: 'app.can', sources: [], sourcesContent: [], names: [], mappings: '' } }],
    callables: [], operations: [], pages: [{ owner: 'installed', path: '/main', module: 'app/main.js', export: 'descriptor' }], requires: [], tests: [],
  };
  const options = { verdict: { active: true }, assets: { valuesWasm: true, browser: true } };
  const plain = api.buildDeployBundle(artifact, { verdict: options.verdict });
  const first = api.buildDeployBundleWithAssets(artifact, options);
  const second = api.buildDeployBundleWithAssets(artifact, options);
  assert.deepEqual(first, second, 'installed Worker and asset bytes must be deterministic');
  const stagedObserver = first.modules['vendor/state/receipt/observer.js'];
  assert.ok(stagedObserver, 'installed Worker stages the B receipt observer');
  assert.ok(stagedObserver.includes('loadSelectedReceiptObserver'), 'staged observer serves the seam loader');
  assert.ok(
    stagedObserver.includes('../../work/receipt/index.js'),
    'staged observer resolves the owning producer through the rewritten vendor leg',
  );
  assert.ok(!/import\(['"]@canlang\//.test(stagedObserver), 'staged observer keeps no bare dynamic import');
  assert.ok(!/\bfrom ['"]@canlang\//.test(stagedObserver), 'staged observer keeps no bare static import');
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
  const receiptEntry = ownerModule('@canlang/state/receipt');
  const receipt = await import(receiptEntry);
  const observerMod = await receipt.loadReceiptObserver();
  assert.equal(typeof observerMod.loadSelectedReceiptObserver, 'function', 'installed observer serves the seam loader');
  const { observeSelectedReceipt: installedObserve } = await observerMod.loadSelectedReceiptObserver();

  // The public Work producer and its real relative cycle must survive packing.
  // Optional State observer absence remains distinct from this present producer.
  const workReceiptEntry = ownerModule('@canlang/work/receipt');
  const workReceipt = await import(workReceiptEntry);
  const workObservation = await import(ownerModule('@canlang/work/observation/observation'));
  const workAssociation = await import(ownerModule('@canlang/work/observation/association'));
  const workFns = await workReceipt.loadWorkReceiptFns();
  assert.equal(workFns.observeSelectedReceipt, workObservation.observeSelectedReceipt);
  assert.equal(installedObserve, workObservation.observeSelectedReceipt, 'installed B observer hands the owning producer function straight through');
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

  // Native membership and dispatch must share the defining private guard state.
  const dispatchEntry = ownerModule('@canlang/work/dispatch');
  const dispatchKey = 'vendor/work/dispatch/index.js';
  assert.deepEqual(Object.keys(first.modules).filter(key => key.endsWith('/dispatch/index.js')), [dispatchKey]);
  const dispatchProducer = await import(dispatchEntry);
  assert.equal(typeof dispatchProducer.readDispatchGuardExecution, 'function');
  assert.equal(typeof dispatchProducer.registerDispatchGuardRevalidation, 'function');
  assert.match(first.modules['runtime/native-membership.js'], /from ['"]\.\.\/vendor\/work\/dispatch\/index\.js['"]/);
  assert.ok(first.modules['runtime/invoke.js'].includes('../vendor/work/dispatch/index.js'));
  assert.ok(first.modules[dispatchKey].includes('../../state/index.js'));
  const missingDispatch = { ...first.modules }; delete missingDispatch[dispatchKey];
  assert.throws(() => api.assertLinksResolve(missingDispatch), /(?:invoke|native-membership)\.js.*dispatch\/index\.js.*no such staged module/);

  const committedKey = 'vendor/work/kernel/committed-model-source.js';
  const invokeEntry = ownerModule('@canlang/cloudflare/runtime/invoke');
  const actualInvoke = readFileSync(invokeEntry, 'utf8');
  assert.match(actualInvoke, /^\s*import\s*\{\s*createCommittedModelSourceStager\s*,\s*stageDeclaredEventSources\s*,\s*createStandardCompletionSourceCommand\s*\}\s*from\s*['"]@canlang\/work['"]/m,
    'the actual installed runtime must consume the genuine public named stager');
  assert.match(first.modules['runtime/invoke.js'], /^\s*import\s*\{\s*createCommittedModelSourceStager\s*,\s*stageDeclaredEventSources\s*\}\s*from\s*['"]\.\.\/vendor\/work\/kernel\/committed-model-source\.js['"]/m,
    'the actual runtime named factory must resolve to the genuine defining Work module');
  assert.match(first.modules['runtime/invoke.js'], /loadProducerModule\(['"]\.\.\/vendor\/state\/mutation\/index\.js['"],\s*['"]committed model source lifetime['"]\)/,
    'the actual source-stage reader must resolve to the same canonical State instance');
  assert.match(first.modules['runtime/invoke.js'], /\bcreateCommittedModelSourceStager\s*\(/,
    'the actual committed-model consumer must call the genuine named factory');
  const committedFile = installedFile(new URL('kernel/committed-model-source.js', distributions.work.modules));
  const publicWork = await import(ownerModule('@canlang/work'));
  const committedProducer = await import(pathToFileURL(committedFile));
  assert.equal(typeof committedProducer.createCommittedModelSourceStager, 'function');
  assert.equal(publicWork.createCommittedModelSourceStager, committedProducer.createCommittedModelSourceStager);
  assert.ok(first.modules[committedKey].includes('../../state/index.js'));
  assert.ok(!first.modules[committedKey].includes('@canlang/state'));
  assert.equal(first.modules['vendor/work/index.js'], undefined, 'the Node-capable public barrel must not enter the Worker graph');
  assert.deepEqual(Object.keys(first.modules).filter(key => key.endsWith('/mutation/source-finalization.js')), ['vendor/state/mutation/source-finalization.js']);
  for (const key of [committedKey, 'vendor/state/index.js', 'vendor/state/mutation/source-finalization.js']) {
    const missing = { ...first.modules }; delete missing[key];
    assert.throws(() => api.assertLinksResolve(missing), /no such staged module/, `missing canonical source-stage ${key}`);
  }
  const savedCommitted = readFileSync(committedFile);
  try {
    writeFileSync(committedFile, 'export function {\n');
    assert.throws(() => api.buildDeployBundle(artifact, { verdict: options.verdict }), /committed-model-source\.js/, 'corrupt genuine stager must fail the existing loadability guard');
  } finally { writeFileSync(committedFile, savedCommitted); }

  const filesClosure = ['vendor/files/bridge.js', 'vendor/files/finalize/index.js', 'vendor/files/upload/index.js', 'vendor/files/provenance/index.js', 'vendor/files/ports.js'];
  assert.deepEqual(Object.keys(first.modules).filter(key => key.startsWith('vendor/files/')).sort(), [...filesClosure].sort());
  const filesBridgeEntry = ownerModule('@canlang/files/bridge');
  assert.equal(first.modules['vendor/files/bridge.js'], readFileSync(filesBridgeEntry, 'utf8'));
  assert.match(first.modules['runtime/invoke.js'], /from ['"]\.\.\/vendor\/files\/bridge\.js['"]/);
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
  const acornRuntime = first.modules['runtime/invoke.js'];
  assert.match(acornRuntime, /^\s*import\s*\{\s*parse\s+as\s+parseJavaScript\s*\}\s*from\s*['"]\.\.\/vendor\/acorn\/acorn\.js['"]/m,
    'actual released runtime parser must import the canonical staged Acorn producer');
  assert.doesNotMatch(acornRuntime, /^\s*import\b[^\n]*\bfrom\s*['"]acorn['"]/m,
    'actual runtime must not retain a bare Acorn import');
  const missingAcorn = { ...first.modules };
  delete missingAcorn[acornKey];
  assert.throws(() => api.assertLinksResolve(missingAcorn), /no such staged module/, 'missing actual Acorn ESM key');

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
  producerFiles.push(['Work committed-model source', committedFile]);
  producerFiles.push(['Work dispatch execution', fileURLToPath(dispatchEntry)]);
  producerFiles.push(['Files page bridge', fileURLToPath(filesBridgeEntry)]);
  for (const [specifier, file] of producerFiles) {
    const saved = readFileSync(file);
    try {
      rmSync(file);
      assert.throws(() => api.buildDeployBundle(artifact, { verdict: options.verdict }),
        error => {
          const absent = error.code === 'ENOENT' ? error : error.cause;
          return absent?.code === 'ENOENT' && typeof absent.path === 'string' &&
            join(realpathSync(dirname(absent.path)), basename(absent.path)) === file && /not built|ENOENT/.test(error.message);
        }, `missing real ${specifier}`);
    } finally { writeFileSync(file, saved); }
  }

  // Boot the actual installed production entry, including its assembly and D1
  // producer graph. A credential-free initialize request reaches the auth seam.
  const { Miniflare } = await import(ownerModule('miniflare').href);
  const { COMPILED_WASM_MODULE_TYPE } = await import(ownerModule('@canlang/contracts').href);
  async function startWorker({ workerName, compatibilityDate, mainModule, modules, binaryModules = {}, d1Databases = [] }) {
    const ordered = [mainModule, ...Object.keys(modules).filter(name => name !== mainModule)];
    const worker = new Miniflare({ name: workerName, compatibilityDate, modules: [
      ...ordered.map(path => ({ path, type: 'ESModule', contents: modules[path] })),
      ...Object.entries(binaryModules).map(([path, bytes]) => ({ path, type: COMPILED_WASM_MODULE_TYPE, contents: new Uint8Array(bytes) })),
    ], d1Databases: Object.fromEntries(d1Databases.map(({ binding, id }) => [binding, id])) });
    try { await worker.ready; }
    catch (error) { await worker.dispose(); throw error; }
    return { dispatch: (path, init) => worker.dispatchFetch(new URL(path, 'http://localhost').href, init), dispose: () => worker.dispose() };
  }
  const production = await startWorker({
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
  // digest/strict decoder, current byte/snapshot readers, nongrant extractor and Acorn parser. The
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
    'import { readFinalizedFileObservation, ingestVerifiedEventBytes, readCurrentFinalizedBytes, readCurrentFinalizedSnapshot, blobKeyForFile } from "./vendor/files/finalize/index.js";',
    'import { TestOnlyMemoryBlobStore, TestOnlyMemoryFinalizedStore, TestOnlyMemoryIntentStore, TestOnlyCounterFileIds } from "./vendor/files/ports.js";',
    `import { parse, version } from ${JSON.stringify('./' + acornKey)};`,
    `import { createCommittedModelSourceStager } from ${JSON.stringify('./' + committedKey)};`,
    'import * as sourceState from "./vendor/state/index.js";',
    'import * as mutationState from "./vendor/state/mutation/index.js";',
    'import { createMemoryStorage } from "./vendor/state/storage/memory.js";',
    'glue.initSync({ module: compiled });',
    'const backend = wasmBackend(glue);',
    `const ast = parse(${JSON.stringify(parserSource)}, { ecmaVersion: 'latest', sourceType: 'module' });`,
    'let malformedRejected = false; try { parse("export const =", { ecmaVersion: "latest", sourceType: "module" }); } catch (error) { malformedRejected = error instanceof SyntaxError; }',
    'const acorn = { version, declaration: ast.body[0].type, escapedKey: ast.body[0].declaration.declarations[0].init.properties[0].key.value, trailing: ast.body[1].type, malformedRejected };',
    'async function probeCommittedSource() {',
    '  const store = createMemoryStorage(); const table = sourceState.buildModelTable([{ model: "Probe.Item", fields: {}, refs: [], uniqueKeys: [], deleteMode: "remove", hooks: [], invariants: [], locks: [] }]);',
    '  const context = { kind: "user", app: "portable-source", actor: { userId: "portable-user" }, team: { teamId: "portable-owner", timezone: "UTC" }, operation: "Probe.change", operationId: "018cc251-f400-7000-8000-000000000001", source: "portable-probe", now: 1700000000000 };',
    '  let liveToken, selectors = 0; const stager = createCommittedModelSourceStager({ routesForChange: (_change, ctx) => { selectors++; return { scope: { app: ctx.app, owner: ctx.team.teamId, ownerPackage: "Probe" }, handlers: [] }; }, occurrenceIds: { nextOccurrenceId: () => { throw new Error("empty route must not allocate"); } }, bounds: { maxSources: 1, maxHandlers: 1, maxMembers: 1, chunkSize: 1 } });',
    '  const session = await mutationState.beginOwnerMutation({ table, store, context, bounds: { maxRows: 4, maxWork: 100 }, stageSources: async token => { liveToken = token; sourceState.readOwnerMutationSourceStage(token); return stager(token); } });',
    '  await session.stage({ op: "create", model: "Probe.Item", id: "portable-row", data: {} }, { cause: "scenario" }); const output = await session.finalize();',
    '  let closedRejected = false, rawRejected = false; try { await stager(liveToken); } catch (error) { closedRejected = error instanceof sourceState.StateError && error.code === "validation"; } try { sourceState.readOwnerMutationSourceStage({}); } catch (error) { rawRejected = error instanceof sourceState.StateError && error.code === "validation"; }',
    '  return { sameReader: sourceState.readOwnerMutationSourceStage === mutationState.readOwnerMutationSourceStage, sameBegin: sourceState.beginOwnerMutation === mutationState.beginOwnerMutation, selectors, writes: output.writes.length, businessWrites: sourceState.ownerMutationBusinessWrites(output).length, closedRejected, rawRejected, unchangedRevision: await store.readRevision() };',
    '}',
    // Controlled non-durable ports exercise genuine production finalization and
    // physical read code. They establish neither provider authentication nor
    // State grants, shared-reference retention or a durable host read contract.
    'function probeCurrentFileBytes() {',
    '  let now = 1700000000000; const blobs = new TestOnlyMemoryBlobStore(), files = new TestOnlyMemoryFinalizedStore(); const deps = { clock: { nowMs: () => now }, blobs, files, intents: new TestOnlyMemoryIntentStore(), fileIds: new TestOnlyCounterFileIds("portable_file") };',
    '  const receiver = { app: "portable-files", team: "portable-team", owner: "portable-owner", principal: "portable-principal" }; const policy = { types: ["application/pdf"], maxBytes: 64 }, retention = { unattachedHorizonMs: 1000, retentionMs: 2000 }, options = { policy, retention }; const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);',
    '  const finalized = ingestVerifiedEventBytes(deps, { provenance: { kind: "event", source: "portable.fixture", adapter: "portable.fixture", occurrenceId: "portable_occurrence", fieldPath: "output", itemIndex: 0 }, receiver, claimedType: "application/pdf", bytes: pdf, policy }); if (finalized.status !== "finalized") throw new Error("genuine Files fixture finalization refused");',
    '  const ref = finalized.file.id, key = blobKeyForFile(ref), originalRead = blobs.read.bind(blobs), snapshot = originalRead(key), changed = new Uint8Array(pdf); changed[0] ^= 1; let readCount = 0; blobs.read = incoming => { if (incoming !== key) throw new Error("foreign byte key"); return ++readCount === 1 ? snapshot : changed; };',
    '  let current; try { current = readCurrentFinalizedBytes(deps, ref, receiver, options); } finally { blobs.read = originalRead; } if (current === null) throw new Error("current physical read refused"); const detachedSnapshot = current !== snapshot;',
    '  let validated, snapshotReadCount = 0; blobs.read = incoming => { if (incoming !== key) throw new Error("foreign snapshot key"); return ++snapshotReadCount === 1 ? snapshot : changed; }; try { validated = readCurrentFinalizedSnapshot(deps, ref, receiver, options); } finally { blobs.read = originalRead; } if (validated === null) throw new Error("current physical snapshot refused"); snapshot[0] ^= 1;',
    '  const foreign = { ...receiver, principal: "foreign" }; const foreignRejected = readCurrentFinalizedBytes(deps, ref, foreign, options) === null, snapshotForeignRejected = readCurrentFinalizedSnapshot(deps, ref, foreign, options) === null; blobs.write(key, changed); const corruptRejected = readCurrentFinalizedBytes(deps, ref, receiver, options) === null, snapshotCorruptRejected = readCurrentFinalizedSnapshot(deps, ref, receiver, options) === null; blobs.write(key, pdf); now += retention.unattachedHorizonMs; const expiredBeforeSweep = readCurrentFinalizedBytes(deps, ref, receiver, options) === null, snapshotExpired = readCurrentFinalizedSnapshot(deps, ref, receiver, options) === null;',
    '  return { currentBytes: Array.from(current), readCount, detachedSnapshot, foreignRejected, corruptRejected, expiredBeforeSweep, state: files.get(ref).state, snapshot: { bytes: Array.from(validated.bytes), readCount: snapshotReadCount, detached: validated.bytes !== snapshot, sameRef: validated.facts.ref === ref, contentType: validated.facts.contentType, sizeBytes: validated.facts.sizeBytes, bytesDigest: validated.facts.bytesDigest, finalizedAtMs: validated.facts.finalizedAtMs, frozen: [validated, validated.facts, validated.facts.receiver, validated.facts.provenance, validated.facts.retention].every(Object.isFrozen), observation: readFinalizedFileObservation(validated), foreignRejected: snapshotForeignRejected, corruptRejected: snapshotCorruptRejected, expiredBeforeSweep: snapshotExpired } };',
    '}',
    'export default { async fetch() { const bytes = new Uint8Array([0x99, 0x00, 0xff, 0x80, 0x01, 0x77]).subarray(1, 5); return Response.json({ compiled: compiled instanceof WebAssembly.Module, abi: glue.abi_version(), sum: String(backend.call("add-int", [1n, 2n])), acorn, committedSource: await probeCommittedSource(), files: { slicedDigest: sha256Hex(bytes), pdf: checkContent({ types: ["application/pdf"], maxBytes: 64 }, "text/plain", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), invalidText: checkContent({ types: ["text/plain"], maxBytes: 64 }, "text/plain", new Uint8Array([0xc3, 0x28])), rawObservation: readFinalizedFileObservation({}), currentRead: probeCurrentFileBytes() } }); } };',
  ].join('\n');
  const wasmWorker = await startWorker({
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
    }, committedSource: { sameReader: true, sameBegin: true, selectors: 1, writes: 1, businessWrites: 1, closedRejected: true, rawRejected: true, unchangedRevision: 0 }, files: {
      slicedDigest: `sha256:${digest(new Uint8Array([0x00, 0xff, 0x80, 0x01]))}`,
      pdf: { claimedType: 'text/plain', detectedType: 'application/pdf', sizeBytes: 5, verdict: 'accepted' },
      invalidText: { claimedType: 'text/plain', detectedType: null, sizeBytes: 2, verdict: 'rejected' },
      rawObservation: null,
      currentRead: { currentBytes: [0x25, 0x50, 0x44, 0x46, 0x2d], readCount: 1, detachedSnapshot: true,
        foreignRejected: true, corruptRejected: true, expiredBeforeSweep: true, state: 'finalized',
        snapshot: { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], readCount: 1, detached: true, sameRef: true,
          contentType: 'application/pdf', sizeBytes: 5, bytesDigest: `sha256:${digest(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))}`,
          finalizedAtMs: 1700000000000, frozen: true, observation: null,
          foreignRejected: true, corruptRejected: true, expiredBeforeSweep: true } },
    } });
  } finally {
    await wasmWorker.dispose();
  }

  // Mutate only installed scratch copies. Default Worker builds remain usable;
  // opted-in inventory must reject missing/corrupt producer bytes explicitly.
  for (const [file, name] of [
    [fileURLToPath(new URL('generated/values_semantics_bg.wasm', distributions.values.bindings)), 'values_semantics_bg.wasm'],
    [fileURLToPath(new URL('can-style.css', distributions.ui.browser)), 'can-style.css'],
  ]) {
    const saved = readFileSync(file);
    try {
      rmSync(file);
      api.buildDeployBundle(artifact, { verdict: options.verdict });
      assert.throws(() => api.buildDeployBundleWithAssets(artifact, options), error => error.message.includes(name), `missing ${name} must fail closed`);
      const corrupt = Buffer.from(saved);
      corrupt[0] ^= 1;
      writeFileSync(file, corrupt);
      assert.throws(() => api.buildDeployBundleWithAssets(artifact, options), error => error.message.includes(name) && /integrity|digest|hash|mismatch/i.test(error.message), `corrupt ${name} must fail closed`);
    } finally {
      writeFileSync(file, saved);
    }
  }
  console.log(`Installed Worker verification passed: ${first.moduleCount} modules, ${Object.keys(first.resources).length} browser resources, values Wasm and production Worker execution.`);
}

if (process.argv[2] === '--consumer') {
  await verifyConsumer(process.argv[3]);
} else {
  const checkout = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  if (!minimumNode22) assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node 24 or newer for the filesystem permission regression');
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
  // Keep the consumer's filesystem regression closed to WorkerThreads. esbuild's
  // real synchronous child-process path needs only the already-declared child grant.
  execFileSync(process.execPath, [permissionFlag, `--allow-fs-read=${scratch}`, `--allow-fs-write=${scratch}`, '--allow-child-process', script, '--consumer', checkout, ...(minimumNode22 ? ['--minimum-node22'] : [])], { cwd: consumer, env: { ...process.env, TMPDIR: scratch, ESBUILD_WORKER_THREADS: '0' }, stdio: 'inherit' });
  rmSync(scratch, { recursive: true, force: true });
}
