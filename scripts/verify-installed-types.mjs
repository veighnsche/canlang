#!/usr/bin/env node
/** Tarball-only declaration acceptance. --skip-build uses existing producer outputs.
 * Default Node24 permission profile; --minimum-node22 requires Node22.0.0. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { builtinModules } from 'node:module';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const inside = (file, dir) => { const rel = relative(dir, file); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'); };
const packageName = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
const minimumNode22 = process.argv.includes('--minimum-node22');
if (minimumNode22) assert.equal(process.version, 'v22.0.0', 'Minimum-engine qualification requires exactly Node22.0.0');
const permissionFlag = minimumNode22 ? '--experimental-permission' : '--permission';

async function consumerCheck(checkout) {
  const consumer = realpathSync(process.cwd());
  assert.throws(() => readFileSync(join(checkout, 'package.json')), error => error.code === 'ERR_ACCESS_DENIED');
  const ts = (await import('typescript')).default;
  const names = Object.keys(json('package.json').dependencies).sort();
  const entries = [], owners = new Map();
  for (const name of names) {
    const directory = realpathSync(join(consumer, 'node_modules', name));
    assert.ok(inside(directory, consumer), `${name} escapes installed consumer`);
    const manifest = json(join(directory, 'package.json'));
    owners.set(name, { directory, manifest });
    for (const [key, target] of Object.entries(manifest.exports)) {
      if (typeof target !== 'object' || typeof target.types !== 'string') { continue; }
      assert.ok(!key.includes('*'), 'Add explicit wildcard expansion before accepting wildcard type exports');
      const specifier = name + (key === '.' ? '' : key.slice(1));
      const declaration = realpathSync(join(directory, target.types));
      assert.ok(inside(declaration, directory), `${specifier} declaration escapes owner`);
      entries.push({ specifier, declaration, owner: name });
    }
  }
  writeFileSync('consumer.ts', entries.map((entry, index) => `import type * as Export${index} from ${JSON.stringify(entry.specifier)};\nexport type Check${index} = typeof Export${index};`).join('\n') + '\n' + [
    'import { absInt } from "@canlang/stdlib";',
    'import { createD1Storage } from "@canlang/state/storage/d1";',
    'import type { StoragePort } from "@canlang/state/storage";',
    'import type { D1Database } from "@cloudflare/workers-types";',
    'const exactInteger: bigint = absInt(-1n);',
    'declare const database: D1Database;',
    'const storage: StoragePort = createD1Storage(database);',
  ].join('\n') + '\n');
  const options = { noEmit: true, strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, skipLibCheck: false, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'], types: ['node'], typeRoots: [join(consumer, 'node_modules/@types')] };
  const ownerOf = file => {
    const absolute = isAbsolute(file) ? file : join(consumer, file);
    const canonical = existsSync(absolute) ? realpathSync(absolute) : absolute;
    return [...owners].find(([, item]) => inside(canonical, item.directory));
  };
  const isOwnedDiagnostic = diagnostic => !diagnostic.file ||
    realpathSync(join(consumer, diagnostic.file)) === realpathSync(join(consumer, 'consumer.ts')) ||
    Boolean(ownerOf(diagnostic.file));
  const host = ts.createCompilerHost(options);
  const undeclared = [];
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map(specifier => {
    const resolved = ts.resolveModuleName(specifier, containingFile, options, host).resolvedModule;
    if (resolved) {
      const file = realpathSync(resolved.resolvedFileName);
      assert.ok(inside(file, consumer), `resolution escapes consumer: ${specifier} -> ${file}`);
    }
    const owner = ownerOf(containingFile);
    if (owner && !specifier.startsWith('.') && !specifier.startsWith('node:') && !builtinModules.includes(specifier)) {
      const dep = packageName(specifier), manifest = owner[1].manifest;
      // Node/Worker declarations are explicit consumer tooling, never producer source aliases.
      if (dep !== owner[0] && !manifest.dependencies?.[dep] && !manifest.peerDependencies?.[dep] && !manifest.optionalDependencies?.[dep] && !['@cloudflare/workers-types', '@types/node'].includes(dep)) undeclared.push({ owner: owner[0], from: relative(consumer, containingFile), specifier });
    }
    return resolved;
  });
  function compile() {
    const program = ts.createProgram([join(consumer, 'consumer.ts')], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ({ code: d.code, file: d.file ? relative(consumer, d.file.fileName) : undefined, start: d.start, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') }));
    for (const source of program.getSourceFiles()) assert.ok(inside(realpathSync(source.fileName), consumer), `program source escapes consumer: ${source.fileName}`);
    const checker = program.getTypeChecker();
    for (const entry of entries) {
      const source = program.getSourceFile(entry.declaration);
      assert.ok(source, `typed export not loaded: ${entry.specifier}`);
      const symbol = checker.getSymbolAtLocation(source);
      assert.ok(symbol && checker.getExportsOfModule(symbol).length > 0, `typed export has no symbols: ${entry.specifier}`);
    }
    return { diagnostics, ownedDiagnostics: diagnostics.filter(isOwnedDiagnostic) };
  }
  const result = compile();
  if (result.ownedDiagnostics.length || undeclared.length) {
    save('diagnostics.json', { diagnostics: result.diagnostics, undeclaredImports: undeclared });
  }
  assert.equal(result.ownedDiagnostics.length, 0, 'consumer or owned declarations produced diagnostics; inspect diagnostics.json');
  assert.equal(undeclared.length, 0, 'installed declarations use undeclared dependencies; inspect diagnostics.json');
  const thirdPartyCount = result.diagnostics.length - result.ownedDiagnostics.length;
  console.log(`Installed declaration verification passed: ${entries.length} typed exports, ${names.length} packages; ${thirdPartyCount} third-party diagnostics.`);
}

if (process.argv[2] === '--consumer') await consumerCheck(process.argv[3]);
else {
  if (!minimumNode22) assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node 24+ for checkout read denial');
  const checkout = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  if (!process.argv.includes('--skip-build')) execFileSync('bun', ['run', 'build'], { cwd: checkout, stdio: 'inherit' });
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'canlang-installed-types-'));
  console.log(`Installed declaration scratch (retained on failure): ${scratch}`);
  const consumer = join(scratch, 'consumer'), tarballs = join(scratch, 'tarballs');
  mkdirSync(consumer); mkdirSync(tarballs);
  const dependencies = {};
  for (const item of readdirSync(join(checkout, 'packages'), { withFileTypes: true }).filter(item => item.isDirectory())) {
    const directory = join(checkout, 'packages', item.name), manifest = json(join(directory, 'package.json'));
    if (!manifest.name.startsWith('@canlang/')) continue;
    const file = join(tarballs, `${item.name}.tgz`);
    execFileSync('bun', ['pm', 'pack', '--ignore-scripts', '--filename', file, '--quiet'], { cwd: directory, stdio: 'pipe' });
    dependencies[manifest.name] = `file:${file}`;
  }
  assert.ok(Object.keys(dependencies).length > 0, 'No workspace packages found');
  save(join(consumer, 'package.json'), { name: 'canlang-installed-types-consumer', private: true, type: 'module', dependencies, overrides: dependencies, devDependencies: { typescript: '5.9.3', '@types/node': '24.19.1', '@cloudflare/workers-types': '5.20261004.1' } });
  writeFileSync(join(consumer, 'bunfig.toml'), '[install]\nlinker = "isolated"\n');
  execFileSync('bun', ['install', '--ignore-scripts'], { cwd: consumer, env: { ...process.env, TMPDIR: scratch }, stdio: 'inherit' });
  // Bun pm pack rewrites workspace ranges to versions; overrides force every owner to its actual tarball.
  const script = join(consumer, 'verify.mjs');
  copyFileSync(fileURLToPath(import.meta.url), script);
  execFileSync(process.execPath, [permissionFlag, `--allow-fs-read=${scratch}`, `--allow-fs-write=${scratch}`, script, '--consumer', checkout, ...(minimumNode22 ? ['--minimum-node22'] : [])], { cwd: consumer, env: { ...process.env, TMPDIR: scratch }, stdio: 'inherit' });
  rmSync(scratch, { recursive: true, force: true });
}
