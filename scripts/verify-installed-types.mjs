#!/usr/bin/env node
/** Tarball-only declaration acceptance. --skip-build uses existing producer outputs. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const inside = (file, dir) => { const rel = relative(dir, file); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'); };
const packageName = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

async function consumerCheck(checkout) {
  const consumer = realpathSync(process.cwd());
  assert.throws(() => readFileSync(join(checkout, 'package.json')), error => error.code === 'ERR_ACCESS_DENIED');
  const ts = (await import('typescript')).default;
  assert.equal(ts.version, '5.9.3');
  const names = Object.keys(json('package.json').dependencies).sort();
  assert.equal(names.length, 13);
  const entries = [], excluded = [], owners = new Map();
  for (const name of names) {
    const directory = realpathSync(join(consumer, 'node_modules', name));
    assert.ok(inside(directory, consumer), `${name} escapes installed consumer`);
    const manifest = json(join(directory, 'package.json'));
    owners.set(name, { directory, manifest });
    for (const [key, target] of Object.entries(manifest.exports)) {
      if (typeof target !== 'object' || typeof target.types !== 'string') { excluded.push({ name, key, reason: 'no declared types condition (asset or untyped entry)' }); continue; }
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
  const resolutions = [], undeclared = [];
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map(specifier => {
    const resolved = ts.resolveModuleName(specifier, containingFile, options, host).resolvedModule;
    if (resolved) {
      const file = realpathSync(resolved.resolvedFileName);
      assert.ok(inside(file, consumer), `resolution escapes consumer: ${specifier} -> ${file}`);
      resolutions.push({ from: relative(consumer, containingFile), specifier, to: relative(consumer, file) });
    }
    const owner = ownerOf(containingFile);
    if (owner && !specifier.startsWith('.') && !specifier.startsWith('node:') && !builtinModules.includes(specifier)) {
      const dep = packageName(specifier), manifest = owner[1].manifest;
      // Node/Worker declarations are explicit consumer tooling, never producer source aliases.
      if (dep !== owner[0] && !manifest.dependencies?.[dep] && !manifest.peerDependencies?.[dep] && !['@cloudflare/workers-types', '@types/node'].includes(dep)) undeclared.push({ owner: owner[0], from: relative(consumer, containingFile), specifier });
    }
    return resolved;
  });
  function compile(label) {
    const program = ts.createProgram([join(consumer, 'consumer.ts')], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ({ code: d.code, file: d.file ? relative(consumer, d.file.fileName) : undefined, start: d.start, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') }));
    for (const source of program.getSourceFiles()) assert.ok(inside(realpathSync(source.fileName), consumer), `program source escapes consumer: ${source.fileName}`);
    save(`${label}-diagnostics.json`, diagnostics);
    return { diagnostics, ownedDiagnostics: diagnostics.filter(isOwnedDiagnostic), sources: program.getSourceFiles().map(source => relative(consumer, source.fileName)) };
  }
  function gate(result) {
    assert.equal(result.ownedDiagnostics.length, 0, 'consumer or owned declarations produced diagnostics; inspect raw diagnostics');
    assert.equal(undeclared.length, 0, 'installed declarations use undeclared dependencies; inspect undeclared-imports.json');
  }
  const baseline = compile('baseline');
  const symbolProgram = ts.createProgram([join(consumer, 'consumer.ts')], options, host);
  const checker = symbolProgram.getTypeChecker();
  const symbols = entries.map(entry => {
    const source = symbolProgram.getSourceFile(entry.declaration);
    assert.ok(source, `typed export not loaded: ${entry.specifier}`);
    const symbol = checker.getSymbolAtLocation(source);
    const exported = symbol ? checker.getExportsOfModule(symbol).map(item => item.name) : [];
    assert.ok(exported.length > 0, `typed export has no symbols: ${entry.specifier}`);
    return { specifier: entry.specifier, symbols: exported };
  });
  save('resolutions.json', resolutions);
  save('undeclared-imports.json', undeclared);
  const evidence = { node: process.version, typescript: ts.version, checkoutRead: 'ERR_ACCESS_DENIED', consumer, linker: 'isolated', ownerLocations: Object.fromEntries([...owners].map(([name, item]) => [name, relative(consumer, item.directory)])), owners: names, exports: entries.map(entry => ({ ...entry, declaration: relative(consumer, entry.declaration) })), excluded, compilerOptions: { ...options, typeRoots: ['node_modules/@types'] }, typeSymbols: symbols, sourceFiles: baseline.sources, diagnostics: baseline.diagnostics, undeclaredImports: undeclared, negativeCases: [] };
  save('evidence.json', evidence);
  const target = entries.find(entry => entry.specifier === '@canlang/contracts');
  assert.ok(target);
  const saved = readFileSync(target.declaration);
  try {
    rmSync(target.declaration);
    const missing = compile('missing-owned-declaration');
    assert.ok(missing.diagnostics.some(d => [2307, 7016].includes(d.code) && d.file === 'consumer.ts'), 'missing export declaration must fail resolution');
    assert.throws(() => gate(missing), /consumer or owned declarations/, 'missing declaration must fail the actual owned/consumer gate');
    evidence.negativeCases.push({ case: 'missing contracts declaration', diagnostics: missing.diagnostics.length, ownedDiagnostics: missing.ownedDiagnostics.length, gateRejected: true });
    writeFileSync(target.declaration, 'export declare const corrupted: MissingInstalledType;\n');
    const corrupt = compile('corrupt-owned-declaration');
    assert.ok(corrupt.diagnostics.some(d => d.code === 2304 && ownerOf(d.file)?.[0] === target.owner), 'corrupt declaration must fail semantic checking');
    assert.throws(() => gate(corrupt), /consumer or owned declarations/, 'corrupt declaration must fail the actual owned/consumer gate');
    evidence.negativeCases.push({ case: 'corrupt contracts declaration', diagnostics: corrupt.diagnostics.length, ownedDiagnostics: corrupt.ownedDiagnostics.length, gateRejected: true });
  } finally { writeFileSync(target.declaration, saved); }
  assert.deepEqual(compile('restored').diagnostics, baseline.diagnostics, 'restoration must recover the baseline exactly');
  save('evidence.json', evidence);
  const ownedDiagnostics = baseline.ownedDiagnostics;
  evidence.ownedDiagnostics = ownedDiagnostics;
  evidence.thirdPartyDiagnostics = baseline.diagnostics.filter(d => !ownedDiagnostics.includes(d));
  const miniflareEntry = ts.resolveModuleName('miniflare', join(owners.get('@canlang/cloudflare').directory, 'dist/dev/local-run.d.ts'), options, host).resolvedModule;
  assert.ok(miniflareEntry, 'installed Miniflare dependency must resolve from its owner');
  let miniflareDirectory = dirname(realpathSync(miniflareEntry.resolvedFileName));
  while (inside(miniflareDirectory, consumer)) {
    const manifestPath = join(miniflareDirectory, 'package.json');
    if (existsSync(manifestPath) && json(manifestPath).name === 'miniflare') break;
    miniflareDirectory = dirname(miniflareDirectory);
  }
  assert.ok(inside(miniflareDirectory, consumer), 'Miniflare manifest escapes installed consumer');
  evidence.thirdPartyVersions = { miniflare: json(join(miniflareDirectory, 'package.json')).version };
  evidence.thirdPartyLocations = { miniflare: relative(consumer, miniflareDirectory) };
  evidence.result = ownedDiagnostics.length === 0 && undeclared.length === 0 ? 'owned declaration and consumer gate passed; third-party diagnostics retained' : 'failed';
  save('evidence.json', evidence);
  gate(baseline);
  console.log(`Installed declaration verification passed: ${entries.length} typed exports, ${names.length} owners; ${evidence.thirdPartyDiagnostics.length} third-party diagnostics retained; evidence ${join(consumer, 'evidence.json')}`);
}

if (process.argv[2] === '--consumer') await consumerCheck(process.argv[3]);
else {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node 24+ for checkout read denial');
  const checkout = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  if (!process.argv.includes('--skip-build')) execFileSync('bun', ['run', 'build'], { cwd: checkout, stdio: 'inherit' });
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'canlang-installed-types-'));
  console.log(`Installed declaration scratch (preserved on success or failure): ${scratch}`);
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
  assert.equal(Object.keys(dependencies).length, 13);
  save(join(consumer, 'package.json'), { name: 'canlang-installed-types-consumer', private: true, type: 'module', dependencies, overrides: dependencies, devDependencies: { typescript: '5.9.3', '@types/node': '24.19.1', '@cloudflare/workers-types': '5.20261004.1' } });
  writeFileSync(join(consumer, 'bunfig.toml'), '[install]\nlinker = "isolated"\n');
  execFileSync('bun', ['install', '--ignore-scripts'], { cwd: consumer, env: { ...process.env, TMPDIR: scratch }, stdio: 'inherit' });
  // Bun pm pack rewrites workspace ranges to versions; overrides force every owner to its actual tarball.
  const script = join(consumer, 'verify.mjs');
  copyFileSync(fileURLToPath(import.meta.url), script);
  execFileSync(process.execPath, ['--permission', `--allow-fs-read=${scratch}`, `--allow-fs-write=${scratch}`, script, '--consumer', checkout], { cwd: consumer, env: { ...process.env, TMPDIR: scratch }, stdio: 'inherit' });
}
