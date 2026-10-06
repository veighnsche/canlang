import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
assert.equal(process.cwd(), projectRoot.replace(/\/$/, ''));
const names = ['cloudflare','contracts','files','identity','interfaces','services','state','stdlib','testkit','ui','values','work','work-kernel'];
const imports = [];
const maps = [];
const mapEscapes = [];
const assets = [];
const checkout = '/Users/vince/Projects/canlang';
function walk(path, f) {
  for (const item of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, item.name);
    assert.ok(!item.isSymbolicLink(), `packed output is symlink: ${child}`);
    if (item.isDirectory()) walk(child, f);
    else if (item.isFile()) f(child);
  }
}
for (const name of names) {
  const specifier = '@canlang/' + name;
  const url = import.meta.resolve(specifier);
  const file = realpathSync(fileURLToPath(url));
  assert.ok(file.startsWith(projectRoot), `${specifier} reaches outside installed consumer: ${file}`);
  assert.ok(!file.startsWith(checkout));
  const module = await import(specifier);
  assert.ok(Object.keys(module).length > 0, `${specifier} is empty`);
  imports.push({ specifier, file: relative(projectRoot, file), exports: Object.keys(module).length });
  const packageRoot = realpathSync(join(projectRoot, 'node_modules/@canlang', name));
  walk(packageRoot, (path) => {
    if (path.endsWith('.map')) {
      const map = JSON.parse(readFileSync(path, 'utf8'));
      for (const source of map.sources ?? []) {
        if (/^[a-zA-Z]+:/.test(source)) continue;
        const target = resolve(dirname(path), map.sourceRoot ?? '', source);
        maps.push({ package: name, target });
        if (!target.startsWith(packageRoot + '/')) mapEscapes.push({ package: name, file: relative(packageRoot, path), source });
        assert.ok(!target.startsWith(checkout), `source map reaches checkout: ${path}`);
      }
    } else if (path.endsWith('.js')) {
      const js = readFileSync(path, 'utf8');
      assert.ok(!js.includes(checkout), `compiled code contains checkout path: ${path}`);
    } else if (path.endsWith('.wasm')) {
      const bytes = readFileSync(path);
      assets.push({ package: name, path: relative(packageRoot, path), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    }
  });
}
// Opt-in values binding: installed asset bytes remain digest pinned, and host
// bootstrap accepts caller-provided bytes without changing default backend use.
const wasmUrl = import.meta.resolve('@canlang/values/bindings/generated/values_semantics_bg.wasm');
const buildUrl = import.meta.resolve('@canlang/values/bindings/generated/BUILD.json');
const wasmBytes = readFileSync(fileURLToPath(wasmUrl));
const build = JSON.parse(readFileSync(fileURLToPath(buildUrl), 'utf8'));
for (const [name, expected] of Object.entries(build.files)) {
  const bytes = readFileSync(new URL(name, buildUrl));
  assert.equal(bytes.length, expected.bytes, 'installed binding bytes: ' + name);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, 'installed binding hash: ' + name);
}
const {bootstrapWasm} = await import('@canlang/values/bindings/bootstrap');
const backend = bootstrapWasm(wasmBytes);
assert.equal(backend.name, 'wasm');
assert.equal(backend.call('add-int', [1n, 2n]), 3n);
const corpusUrl = import.meta.resolve('@canlang/values/conformance/v1/values.json');
const corpus = JSON.parse(readFileSync(fileURLToPath(corpusUrl), 'utf8'));
assert.ok(corpus && typeof corpus === 'object');
const wasmEvidence = {asset:fileURLToPath(wasmUrl),sha256:build.files['values_semantics_bg.wasm'].sha256,bytes:wasmBytes.length,bootstrap:'ABI accepted; add-int(1,2)=3',corpus:fileURLToPath(corpusUrl)};
const { buildDeployBundle, MCP_BUNDLE_MARKERS, HTTP_BUNDLE_MARKERS, MCP_HANDLER_MODULE, HTTP_OPERATIONS_MODULE, assertLinksResolve, assertWorkerdLoadable, writeDeployBundle } = await import('@canlang/cloudflare/deploy/bundle');
const emptyMap = { version:3, file:'app.can', sources:[], sourcesContent:[], names:[], mappings:'' };
const artifact = {
  artifact_version:1, language_version:'1.0.0', tool_version:'0.1.0',
  sources:[{path:'app.can',sha256:'0'.repeat(64)}],
  modules:[{path:'app/main.js',js:'import { renderPage } from "@canlang/ui";\nimport { ok } from "@canlang/stdlib";\nexport const descriptor = {renderPage,ok};\n', map:emptyMap}],
  callables:[], operations:[], pages:[{owner:'test',path:'/main',module:'app/main.js',export:'descriptor'}], requires:[], tests:[],
};
const first = buildDeployBundle(artifact, {repoRoot:projectRoot,verdict:{active:true}});
const second = buildDeployBundle(artifact, {repoRoot:projectRoot,verdict:{active:true}});
assert.equal(first.sha256, second.sha256);
assert.deepEqual(first.modules, second.modules);
assertLinksResolve(first.modules); assertWorkerdLoadable(first.modules);
for (const marker of MCP_BUNDLE_MARKERS) assert.ok(first.modules[MCP_HANDLER_MODULE].includes(marker));
for (const marker of HTTP_BUNDLE_MARKERS) assert.ok(first.modules[HTTP_OPERATIONS_MODULE].includes(marker));
for (const producer of ['contracts','ui','state','values']) {
  assert.ok(Object.keys(first.modules).some(key => key.startsWith('vendor/' + producer + '/')), `missing installed vendor ${producer}`);
}
assert.equal(first.modules['vendor/state/receipt/observer.js'], undefined);
assert.ok(!Object.keys(first.modules).some(key => key.endsWith('/work-loader.js')));
for (const [key, text] of Object.entries(first.modules)) assert.ok(!text.includes(checkout), `bundle reaches checkout: ${key}`);
const receipt = await import('@canlang/state/receipt');
await assert.rejects(receipt.loadReceiptObserver(), e => e.code === 'ERR_MODULE_NOT_FOUND' && e.message.includes(fileURLToPath(receipt.receiptObserverModuleUrl)));
const {loadWorkReceiptFns} = await import('@canlang/work/receipt');
const fns = await loadWorkReceiptFns();
for (const name of ['observeSelectedReceipt','applyReceiptProgress','isConsistentCompletion']) assert.equal(typeof fns[name], 'function');
const written = writeDeployBundle(first, join(projectRoot,'bundle'));
const evidence = {runtime:process.version,imports,mapCount:maps.length,mapEscapes,assets,wasm:wasmEvidence,observer:'absent exact-owning-module rejection preserved',workReceipt:'direct installed producer functions available',bundle:{main:first.mainModule,modules:first.moduleCount,sha256:first.sha256,mcpBytes:first.mcpBundleBytes,httpBytes:first.httpOperationsBytes,writtenFiles:written.files.length}};
writeFileSync(join(projectRoot,'evidence.json'), JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
assert.equal(mapEscapes.length,0,'packed source maps must stay inside their owning package');
