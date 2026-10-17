import { createHash } from 'node:crypto';
import { compileFunction, constants } from 'node:vm';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('node:module', async importOriginal => {
  const actual = await importOriginal<typeof import('node:module')>();
  return { ...actual, createRequire: (from: string | URL) => {
    const real = actual.createRequire(from);
    return { resolve: (specifier: string) => {
      if (specifier === 'esbuild' || specifier.startsWith('@esbuild/') || specifier === '@canlang/testkit' || specifier.startsWith('@canlang/testkit/') ||
          ['@playwright/test', 'playwright', 'playwright-core'].some(name=>specifier===name || specifier.startsWith(`${name}/`))) {
        if (specifier === '@canlang/testkit' && String(from).endsWith('/src/dev/preview-inputs.ts')) {
          return actual.createRequire(join(fixture.root, 'bundled/package.json')).resolve(specifier);
        }
        return real.resolve(specifier);
      }
      // Required producers are finite installed fixtures; optional Testkit is
      // resolved by Node from the actual invoking application's node_modules.
      const request = specifier.replace(/\/package\.json$/, '');
      const name = request.startsWith('@canlang/') ? request.split('/').slice(0, 2).join('/') : request;
      return join(fixture.root, 'required', encodeURIComponent(name), 'dist', 'index.js');
    } };
  } };
});
import { assertInstalledCatalog, bundlerExecutableInputs, compilerSourceInputs, installedLocalPreviewInputInventory, installedOwnedSourceInputs, installedPortableBundleInputs } from '../src/dev/preview-inputs.js';

// Run the actual installed Node module and its content-qualified imports in
// one native loader; Vitest's transformed export accessors are not host evidence.
const nativeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
}) as (url: string) => Promise<unknown>;
async function browserQualificationInputs(applicationRoot: string) {
  const installed = await nativeImport(new URL('../dist/dev/preview-inputs.js', import.meta.url).href) as
    typeof import('../src/dev/preview-inputs.js');
  return installed.installedBrowserQualificationInputs(applicationRoot);
}
async function acquisitionCalls(leaf: string): Promise<number> {
  const digest = createHash('sha256').update(await readFile(leaf)).digest('hex');
  const producer = await nativeImport(`${pathToFileURL(leaf).href}?can_browser=${digest}`) as { acquireCalls: number };
  return producer.acquireCalls;
}

let root = '';
afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });
async function prepare() {
  root = await realpath(await mkdtemp(join(tmpdir(), 'can-preview-inputs-')));
  fixture.root = root;
  await writeFile(join(root, 'package.json'), '{}');
  const names = ['cloudflare', 'contracts', 'interfaces', 'identity', 'files', 'state', 'ui', 'stdlib', 'values', 'work', 'services']
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

it('captures bundled Testkit when the application has none and permits packages without source', async () => {
  await prepare();
  const kit = join(root, 'bundled/node_modules/@canlang/testkit');
  await mkdir(join(kit, 'dist'), { recursive: true });
  await writeFile(join(kit, 'package.json'), JSON.stringify({ name: '@canlang/testkit', version: '1.0.0', main: './dist/index.js' }));
  await writeFile(join(kit, 'dist/index.js'), 'export {};');
  expect(installedPortableBundleInputs(root).some(input => input.name === '@canlang/testkit@1.0.0/dist/index.js')).toBe(true);
  expect(installedOwnedSourceInputs(root)).toEqual([]);
  const values = join(root, 'required', encodeURIComponent('@canlang/values'), 'dist');
  await writeFile(join(values, 'catalog.json'), '{}');
  await mkdir(join(values, 'src'));
  await writeFile(join(values, 'src/catalog.js'), 'export {};');
  expect(() => assertInstalledCatalog(root, join(values, 'catalog.json'))).not.toThrow();
});

it('admits only the manifest-owned packaged compiler without checkout source', async () => {
  await prepare();
  await mkdir(join(root, 'libexec'));
  await writeFile(join(root, 'libexec/can'), 'packaged compiler');
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ kind: 'can-install' }));
  await mkdir(join(root, 'docs/specification'), { recursive: true });
  await writeFile(join(root, 'docs/specification/GRAMMAR.md'), 'installed grammar');
  for (const name of ['values', 'ui']) {
    await mkdir(join(root, 'packages', name, 'src'), { recursive: true });
    await writeFile(join(root, 'packages', name, 'src/catalog.ts'), 'export {};');
  }
  await mkdir(join(root, 'application'));
  const previous = process.env.CAN_INSTALL_ROOT;
  process.env.CAN_INSTALL_ROOT = root;
  vi.stubEnv('PATH', '');
  try {
    expect(compilerSourceInputs(root, 'libexec/can')).toEqual([]);
    const inventory = installedLocalPreviewInputInventory(join(root, 'application'), join(root, 'libexec/can'));
    for (const executable of bundlerExecutableInputs()) expect(inventory.extraInputPaths).toContainEqual(executable);
    expect(inventory.extraInputPaths.some(input => input.name === 'bun')).toBe(false);
    expect(inventory.extraInputPaths).toContainEqual({ name: 'grammar', path: join(root, 'docs/specification/GRAMMAR.md') });
    expect(inventory.extraInputPaths).toContainEqual({ name: 'installation-manifest', path: join(root, 'manifest.json') });
    await writeFile(join(root, 'foreign-can'), 'foreign compiler');
    expect(() => compilerSourceInputs(root, 'foreign-can')).toThrow(/checkout compiler target/);
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ kind: 'foreign-install' }));
    expect(() => compilerSourceInputs(root, 'libexec/can')).toThrow(/invalid Can installation manifest/);
  } finally {
    if (previous === undefined) delete process.env.CAN_INSTALL_ROOT;
    else process.env.CAN_INSTALL_ROOT = previous;
  }
});

it('captures legacy tool references and compiler sources through a shared target directory', async () => {
  await prepare();
  await writeFile(join(root, 'tools.json'), JSON.stringify({ schema: 'canlang.tools.v1' }));
  await mkdir(join(root, 'docs/specification'), { recursive: true });
  await writeFile(join(root, 'docs/specification/GRAMMAR.md'), 'tool grammar');
  await mkdir(join(root, 'compiler/src'), { recursive: true });
  await writeFile(join(root, 'compiler/src/main.rs'), 'fn main() {}');
  await mkdir(join(root, 'shared-target/release'), { recursive: true });
  await writeFile(join(root, 'shared-target/release/can'), 'built compiler');
  await symlink(join(root, 'shared-target'), join(root, 'compiler/target'));
  await mkdir(join(root, 'application'));
  vi.stubEnv('CAN_TOOL_ROOT', root);
  const inventory = installedLocalPreviewInputInventory(join(root, 'application'), join(root, 'compiler/target/release/can'));
  expect(inventory.extraInputPaths).toContainEqual({ name: 'grammar', path: join(root, 'docs/specification/GRAMMAR.md') });
  expect(inventory.extraInputPaths).toContainEqual({ name: 'tool-release-manifest', path: join(root, 'tools.json') });
  expect(inventory.extraInputPaths).toContainEqual({ name: 'compiler-source:src/main.rs', path: join(root, 'compiler/src/main.rs') });
  await writeFile(join(root, 'tools.json'), JSON.stringify({ schema: 'foreign-tool' }));
  expect(() => compilerSourceInputs(root, 'compiler/target/release/can')).toThrow(/invalid installed tool release/);
});

it('captures the Node host and native esbuild without PATH tools and honors a selected binary', async () => {
  await prepare();
  vi.stubEnv('PATH', '');
  vi.stubEnv('ESBUILD_BINARY_PATH', '');
  const selected = bundlerExecutableInputs();
  expect(selected[0]).toEqual({ name: 'node', path: await realpath(process.execPath) });
  expect(selected[1]!.name).toBe('esbuild');
  expect(selected[1]!.path).not.toMatch(/\.js$/);
  const override = join(root, 'selected-esbuild');
  await symlink(selected[1]!.path, override);
  vi.stubEnv('ESBUILD_BINARY_PATH', override);
  expect(bundlerExecutableInputs()).toEqual(selected);
  vi.stubEnv('ESBUILD_BINARY_PATH', join(root, 'missing-esbuild'));
  expect(() => bundlerExecutableInputs()).toThrow(/ENOENT/);
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


async function prepareBrowser(options: { driver?: boolean; executable?: boolean } = {}) {
  const kit = await prepare(), driver = options.driver ?? true, available = options.executable ?? true;
  await mkdir(join(kit, 'dist'), { recursive: true });
  await writeFile(join(kit, 'package.json'), JSON.stringify({ name: '@canlang/testkit', version: '1.0.0', type: 'module',
    exports: { '.': './dist/index.js', './browser/chromium': './dist/chromium.js' } }));
  await writeFile(join(kit, 'dist/index.js'), 'export {};');
  const leaf = join(kit, 'dist/chromium.js'), status = join(root, 'availability.json');
  await writeFile(leaf, `import {readFileSync} from 'node:fs';
export let acquireCalls=0;
export async function chromiumAvailability(){return JSON.parse(readFileSync(${JSON.stringify(status)},'utf8'));}
export async function acquireChromium(){acquireCalls++;throw new Error('discovery must not launch');}
`);
  const driverRoot = join(root, 'node_modules/@playwright/test');
  const playwrightRoot = join(root, 'node_modules/playwright');
  const coreRoot = join(root, 'node_modules/playwright-core');
  const driverEntry = join(driverRoot, 'index.js');
  if(driver) {
    for(const [name,path,dependencies] of [
      ['@playwright/test',driverRoot,{playwright:'1.63.0'}],
      ['playwright',playwrightRoot,{'playwright-core':'1.63.0'}],
      ['playwright-core',coreRoot,{}],
    ] as const) {
      await mkdir(path,{recursive:true});
      await writeFile(join(path,'package.json'),JSON.stringify({name,version:'1.63.0',main:'index.js',dependencies}));
      await writeFile(join(path,'index.js'),'module.exports = {};');
    }
    await writeFile(join(coreRoot,'browsers.json'),JSON.stringify({browsers:[{name:'chromium',revision:'1243'}]}));
  }
  const installation = join(root, 'cache/chromium-1243'), executable = join(installation,'chrome/chromium');
  const resource = join(installation,'chrome/icudtl.dat');
  if(driver && available) {
    await mkdir(join(installation,'chrome'),{recursive:true});
    await writeFile(join(installation,'INSTALLATION_COMPLETE'),'');
    await writeFile(executable,'fixture executable');
    await writeFile(resource,'native fixture data');
    await writeFile(join(installation,'chrome/libEGL.dylib'),'native fixture library');
  }
  await writeFile(status,JSON.stringify(!driver ? {available:false,reason:'driver-not-installed'} :
    {available, ...(!available ? {reason:'executable-not-installed'} : {}),identity:{driverEntryPath:driverEntry,executablePath:executable}}));
  return {kit,leaf,driverRoot,playwrightRoot,coreRoot,installation,executable,resource};
}

it('uses the bundled browser producer for an empty application but refuses broken installed leaf exports', async () => {
  await prepare();
  expect((await browserQualificationInputs(root)).some(input => input.name === 'browser:producer' && !input.path.startsWith(root))).toBe(true);
  await rm(root,{recursive:true,force:true});
  const browser = await prepareBrowser({driver:false});
  expect(await browserQualificationInputs(root)).toEqual([{name:'browser:producer',path:browser.leaf}]);
  expect(await acquisitionCalls(browser.leaf)).toBe(0);
  // Node retains package exports resolution; install the broken leaf on a
  // fresh root before its first resolution rather than rewriting cached metadata.
  await rm(root,{recursive:true,force:true});
  const brokenKit = await prepare();
  await mkdir(join(brokenKit,'dist'),{recursive:true});
  await writeFile(join(brokenKit,'dist/index.js'),'export {};');
  await writeFile(join(brokenKit,'package.json'),JSON.stringify({name:'@canlang/testkit',version:'1.0.0',type:'module',
    exports:{'.':'./dist/index.js'}}));
  await expect(browserQualificationInputs(root)).rejects.toThrow(/exports/);
});

it('captures a complete available driver without nonexistent executable inputs and refuses version drift', async () => {
  const browser = await prepareBrowser({executable:false});
  const inputs = await browserQualificationInputs(root);
  for(const name of ['@playwright/test','playwright','playwright-core'])
    expect(inputs.some(input=>input.name===`browser:driver:${name}@1.63.0/package.json`)).toBe(true);
  expect(inputs.some(input=>input.path===browser.executable)).toBe(false);
  expect(inputs.some(input=>input.name==='browser:driver:playwright-core@1.63.0/browsers.json')).toBe(true);
  expect(await acquisitionCalls(browser.leaf)).toBe(0);
  await writeFile(join(browser.coreRoot,'package.json'),JSON.stringify({name:'playwright-core',version:'1.62.0',main:'index.js'}));
  await expect(browserQualificationInputs(root)).rejects.toThrow(/locked producer/);
});

it('captures native browser resources and internal aliases while excluding drivers from the portable closure', async () => {
  const browser = await prepareBrowser();
  const alias = join(browser.installation,'chrome/current.dat'); await symlink(browser.resource,alias);
  const first = await browserQualificationInputs(root);
  expect(first.some(input=>input.name==='browser:executable' && input.path===browser.executable)).toBe(true);
  for(const suffix of ['chrome/chromium','chrome/icudtl.dat','chrome/libEGL.dylib','chrome/current.dat'])
    expect(first.some(input=>input.name===`browser:installation:chromium-1243/${suffix}`)).toBe(true);
  expect(await realpath(first.find(input=>input.path===alias)!.path)).toBe(browser.resource);
  const replacement = join(browser.installation,'chrome/replacement.dat'); await writeFile(replacement,'native fixture data');
  await unlink(alias); await symlink(replacement,alias);
  const second = await browserQualificationInputs(root);
  expect(await realpath(second.find(input=>input.path===alias)!.path)).toBe(replacement);
  expect(second.length).toBe(first.length+1);
  const added = join(browser.installation,'chrome/resources.pak'); await writeFile(added,'new native resource');
  const expanded = await browserQualificationInputs(root);
  expect(expanded.length).toBe(second.length+1); expect(expanded.some(input=>input.path===added)).toBe(true);
  expect(installedPortableBundleInputs(root).some(input=>/playwright|browser:installation/.test(input.name))).toBe(false);
  expect(await acquisitionCalls(browser.leaf)).toBe(0);
});

it('refuses browser aliases escaping the installation and cyclic aliases', async () => {
  const browser = await prepareBrowser(), alias = join(browser.installation,'chrome/alias');
  const outside = join(root,'outside.dat'); await writeFile(outside,'outside installation'); await symlink(outside,alias);
  await expect(browserQualificationInputs(root)).rejects.toThrow(/escapes its installation/);
  await unlink(alias); await symlink(browser.installation,alias);
  await expect(browserQualificationInputs(root)).rejects.toThrow(/directory cycle/);
  expect(await acquisitionCalls(browser.leaf)).toBe(0);
});


it('requires restart after loaded producer or driver code changes at the same path', async () => {
  const producer = await prepareBrowser();
  await browserQualificationInputs(root);
  const leaf = await readFile(producer.leaf,'utf8');
  await writeFile(producer.leaf,`${leaf}
// changed loaded leaf
`);
  await expect(browserQualificationInputs(root)).rejects.toThrow(/loaded browser code changed; restart/);
  await rm(root,{recursive:true,force:true});
  const driver = await prepareBrowser();
  const driverData = join(driver.coreRoot,'runtime.dat'); await writeFile(driverData,'driver data A');
  await browserQualificationInputs(root);
  await writeFile(driverData,'driver data B');
  await expect(browserQualificationInputs(root)).rejects.toThrow(/loaded browser code changed; restart/);
});

it('bounds traversal of deeply nested empty browser directories', async () => {
  const browser = await prepareBrowser();
  let deepest = browser.installation;
  for(let depth=0;depth<65;depth++) deepest=join(deepest,'d');
  await mkdir(deepest,{recursive:true});
  await expect(browserQualificationInputs(root)).rejects.toThrow(/browser traversal exceeds the finite limit/);
});
