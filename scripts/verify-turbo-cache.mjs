#!/usr/bin/env node
/**
 * Destructive cache probes run only in a fresh /tmp snapshot of working bytes.
 * No live output is removed, installed workspace link reused, or Git checkout
 * required. Keep the scratch directory (including raw runs) as review evidence.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const checkout = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'canlang-turbo-cache-'));
const workspace = join(scratch, 'workspace');
const evidence = join(scratch, 'evidence');
const cache = join(scratch, 'cache');
for (const directory of [workspace, evidence, cache]) mkdirSync(directory);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (file, directory) => {
  const path = relative(directory, file);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
};
assert.ok(!inside(scratch, checkout), 'scratch must be outside the live checkout');
const report = { scratch, checkout, node: process.version, scope: '13 TypeScript build tasks; native, catalog, preparation and release tasks are outside this cache proof', hashProbeLimit: 'Lock/config/assets/environment/tool identities are dry-run invalidation probes; no alternate toolchain or native target is executed', phases: [], probes: [] };
const save = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n');
const guarded = file => {
  assert.ok(inside(file, workspace), `mutation escapes snapshot: ${file}`);
  let parent = file;
  while (!existsSync(parent)) parent = dirname(parent);
  assert.ok(inside(realpathSync(parent), workspace), `mutation follows external link: ${file}`);
  return file;
};

// Snapshot active untracked files too. Documentation/evidence and generated
// output are not inputs to these package builds; committed bindings ARE inputs.
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'target', '.turbo', 'coverage', '.wrangler', '.mf', '__pycache__', 'test-results', 'playwright-report']);
const ignoredRootDirectories = new Set(['docs', 'design', 'implementation', 'output']);
const snapshot = {};
function copyTree(source, destination, root = false, ancestry = new Set()) {
  const actual = realpathSync(source);
  assert.ok(inside(actual, checkout), `source link escapes checkout: ${source}`);
  const metadata = statSync(actual);
  if (metadata.isDirectory()) {
    assert.ok(!ancestry.has(actual), `source link cycle: ${source}`);
    mkdirSync(destination, { recursive: true });
    for (const item of readdirSync(actual, { withFileTypes: true })) {
      if (ignoredDirectories.has(item.name) || (root && ignoredRootDirectories.has(item.name)) || item.name.endsWith('.tsbuildinfo') || item.name === '.DS_Store') continue;
      copyTree(join(actual, item.name), join(destination, item.name), false, new Set([...ancestry, actual]));
    }
  } else if (metadata.isFile()) {
    copyFileSync(actual, destination);
    chmodSync(destination, metadata.mode & 0o777);
    snapshot[relative(workspace, destination)] = { sha256: digest(readFileSync(actual)), mode: metadata.mode & 0o777 };
  } else {
    throw new Error(`unsupported snapshot input: ${source}`);
  }
}

let environment;
function command(label, executable, arguments_, { expectedFailure = false, env = environment } = {}) {
  console.log(`cache verifier: ${label}`);
  const result = spawnSync(executable, arguments_, { cwd: workspace, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(evidence, `${label}.stdout.log`), result.stdout ?? '');
  writeFileSync(join(evidence, `${label}.stderr.log`), result.stderr ?? '');
  save(`${label}.command.json`, { executable, arguments: arguments_, exitCode: result.status, error: result.error?.message });
  if (result.error) throw result.error;
  if (expectedFailure) assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  else assert.equal(result.status, 0, `${label} failed; see ${evidence}\n${result.stderr}\n${result.stdout?.slice(-6000)}`);
  return result;
}

function assertInstalledLinks(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, item.name);
    if (item.isSymbolicLink()) assert.ok(inside(realpathSync(file), workspace), `installed link reaches live/external files: ${file}`);
    else if (item.isDirectory()) assertInstalledLinks(file);
  }
}

let owners;
function outputInventory() {
  const result = {};
  function add(file) {
    const metadata = lstatSync(file);
    assert.ok(!metadata.isSymbolicLink(), `output must not be a symlink: ${file}`);
    if (metadata.isDirectory()) for (const item of readdirSync(file)) add(join(file, item));
    else {
      assert.ok(metadata.isFile(), `unexpected output kind: ${file}`);
      result[relative(workspace, file)] = { bytes: metadata.size, sha256: digest(readFileSync(file)), mode: metadata.mode & 0o777 };
    }
  }
  for (const owner of owners.values()) {
    const dist = join(owner.directory, 'dist');
    if (existsSync(dist)) add(dist);
    for (const item of readdirSync(owner.directory)) if (item.endsWith('.tsbuildinfo')) add(join(owner.directory, item));
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
function assertInventory(expected, label) {
  const actual = outputInventory();
  save(`${label}.inventory.json`, actual);
  const actualHash = digest(JSON.stringify(actual));
  const expectedHash = digest(JSON.stringify(expected));
  if (report.phases.length) Object.assign(report.phases.at(-1), { outputFiles: Object.keys(actual).length, inventorySha256: actualHash });
  if (actualHash !== expectedHash) {
    save(`${label}.inventory-difference.json`, {
      missing: Object.keys(expected).filter(file => !actual[file]),
      extra: Object.keys(actual).filter(file => !expected[file]),
      changed: Object.keys(actual).filter(file => expected[file] && JSON.stringify(actual[file]) !== JSON.stringify(expected[file])),
    });
  }
  assert.equal(actualHash, expectedHash, `${label}: complete file inventory/bytes/modes differ; see ${evidence}`);
}
function cleanOutputs(incremental = true) {
  for (const owner of owners.values()) {
    rmSync(guarded(join(owner.directory, 'dist')), { recursive: true, force: true });
    if (incremental) for (const item of readdirSync(owner.directory)) if (item.endsWith('.tsbuildinfo')) rmSync(guarded(join(owner.directory, item)));
  }
}
const expectedIds = () => [...owners.keys()].map(name => `${name}#build`).sort();
const expectedAllIds = () => [...expectedIds(), ...[...owners.keys()].map(name => `${name}#build:prepare`)].sort();
const cacheableTasks = summary => summary.tasks.filter(task => task.task === 'build');
const runsDirectory = join(workspace, '.turbo', 'runs');
let turbo;
const argumentsBase = ['run', 'build', '--env-mode=strict', '--cache-dir', cache];
function runBuild(label, { expectedFailure = false, uncached = false, force = false } = {}) {
  const before = new Set(existsSync(runsDirectory) ? readdirSync(runsDirectory) : []);
  // Turbo 2.11.7 rejects --force together with --cache. An empty cache
  // specification disables reads AND writes; local:w forces local execution.
  const result = command(label, turbo, [...argumentsBase, uncached ? '--cache=' : force ? '--cache=local:w' : '--cache=local:rw', '--summarize', ...(expectedFailure ? ['--continue=dependencies-successful'] : [])], { expectedFailure });
  const created = readdirSync(runsDirectory).filter(file => file.endsWith('.json') && !before.has(file));
  assert.equal(created.length, 1, `${label}: exactly one actual Turbo summary required`);
  const summary = JSON.parse(readFileSync(join(runsDirectory, created[0]), 'utf8'));
  save(`${label}.summary.json`, summary);
  assert.equal(summary.turboVersion, '2.11.7');
  const actualIds = summary.tasks.map(task => task.taskId).sort();
  if (expectedFailure) {
    // Run summaries contain executed tasks only. All dependent builds must be
    // absent after the contracts producer fails; dry-run proves planned edges.
    assert.deepEqual(actualIds, [...[...owners.keys()].map(name => `${name}#build:prepare`), '@canlang/contracts#build'].sort(), `${label}: only the failing producer and uncached preparations may execute`);
  } else assert.deepEqual(actualIds, expectedAllIds(), `${label}: coverage must include all 13 builds and 13 uncached preparations`);
  for (const task of summary.tasks.filter(task => task.task === 'build:prepare')) {
    assert.equal(task.resolvedTaskDefinition.cache, false, `${label}: preparation must never be cached`);
    assert.equal(task.execution?.exitCode, 0, `${label}: ${task.taskId} must actually clean owned outputs`);
    assert.notEqual(task.cache.status, 'HIT', `${label}: output cleaning cannot be a cache hit`);
  }
  if (!expectedFailure) for (const task of summary.tasks) assert.equal(task.execution?.exitCode, 0, `${label}: ${task.taskId} did not complete successfully`);
  report.phases.push({ name: label, exitCode: result.status, globalInternalDependenciesHash: summary.globalCacheInputs.hashOfInternalDependencies, tasks: summary.tasks.map(task => ({ id: task.taskId, hash: task.hash, cache: task.cache.status, exitCode: task.execution?.exitCode })) });
  return summary;
}
function expectCache(summary, misses = new Set()) {
  for (const task of cacheableTasks(summary)) assert.equal(task.cache.status, misses.has(task.taskId) ? 'MISS' : 'HIT', `unexpected cache status for ${task.taskId}`);
}
function dryHashes(label, env = environment) {
  const result = command(label, turbo, [...argumentsBase, '--cache=local:rw', '--dry=json'], { env });
  const value = JSON.parse(result.stdout);
  assert.deepEqual(value.tasks.map(task => task.taskId).sort(), expectedAllIds());
  assert.equal(value.envMode, 'strict');
  for (const task of value.tasks) {
    const owner = owners.get(task.package);
    const declared = { ...owner.manifest.dependencies, ...owner.manifest.devDependencies, ...owner.manifest.optionalDependencies };
    const dependencies = task.task === 'build' ? [...Object.keys(declared).filter(name => owners.has(name)).map(name => `${name}#build`), `${task.package}#build:prepare`].sort() : [];
    assert.deepEqual(task.dependencies.sort(), dependencies, `${task.taskId}: Turbo edges must match runtime and development manifest relationships`);
  }
  save(`${label}.dry.json`, value);
  const hashes = new Map(cacheableTasks(value).map(task => [task.taskId, task.hash]));
  hashes.details = value;
  return hashes;
}
function dependentsOf(name) {
  const affected = new Set([name]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [consumer, owner] of owners) {
      const dependencies = { ...owner.manifest.dependencies, ...owner.manifest.devDependencies, ...owner.manifest.optionalDependencies };
      if (!affected.has(consumer) && Object.keys(dependencies).some(dependency => affected.has(dependency))) { affected.add(consumer); changed = true; }
    }
  }
  return new Set([...affected].map(package_ => `${package_}#build`));
}
function changedHashes(before, after) {
  return [...after].filter(([id, hash]) => before.get(id) !== hash).map(([id]) => id).sort();
}
function fileHashProbe(label, file, mutate, affected, baseline) {
  file = guarded(file);
  const original = readFileSync(file);
  try {
    writeFileSync(file, mutate(original));
    const changed = changedHashes(baseline, dryHashes(label));
    assert.deepEqual(changed, [...affected].sort(), `${label}: wrong invalidation closure`);
    report.probes.push({ name: label, changed });
  } finally { writeFileSync(file, original); }
}

try {
  copyTree(checkout, workspace, true);
  save('snapshot.json', snapshot);
  owners = new Map(readdirSync(join(workspace, 'packages')).filter(name => existsSync(join(workspace, 'packages', name, 'package.json'))).map(name => {
    const directory = join(workspace, 'packages', name);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    return [manifest.name, { directory, manifest }];
  }));
  assert.equal(owners.size, 13, 'update qualification deliberately if the workspace owner set changes');
  assert.equal(JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')).devDependencies.turbo, '2.11.7');
  const installationEnvironment = { ...process.env, TMPDIR: scratch, BUN_INSTALL_CACHE_DIR: join(scratch, 'bun-cache'), TURBO_TELEMETRY_DISABLED: '1', TURBO_DAEMON: 'false' };
  for (const key of ['TURBO_TOKEN', 'TURBO_TEAM', 'TURBO_API', 'TURBO_REMOTE_ONLY', 'TURBO_FORCE']) delete installationEnvironment[key];
  environment = installationEnvironment;
  const frozenLock = readFileSync(join(workspace, 'bun.lock'));
  command('frozen-install', 'bun', ['install', '--frozen-lockfile', '--ignore-scripts']);
  assert.deepEqual(readFileSync(join(workspace, 'bun.lock')), frozenLock, 'frozen install must not rewrite the lock');
  assertInstalledLinks(workspace);
  turbo = realpathSync(join(workspace, 'node_modules', '.bin', 'turbo'));
  assert.ok(inside(turbo, workspace), 'Turbo executable must come from the isolated frozen install');
  // The public runner owns actual platform/tool identity; reuse its pure helper.
  const runner = await import(pathToFileURL(join(workspace, 'scripts', 'run-tasks.mjs')));
  assert.equal(typeof runner.taskEnvironment, 'function', 'run-tasks.mjs must export taskEnvironment without running tasks on import');
  environment = { ...installationEnvironment, ...await runner.taskEnvironment(), TMPDIR: scratch, BUN_INSTALL_CACHE_DIR: join(scratch, 'bun-cache'), TURBO_TELEMETRY_DISABLED: '1', TURBO_DAEMON: 'false' };
  for (const key of ['TURBO_TOKEN', 'TURBO_TEAM', 'TURBO_API', 'TURBO_REMOTE_ONLY', 'TURBO_FORCE']) delete environment[key];
  report.bun = command('bun-version', 'bun', ['--version']).stdout.trim();
  report.turbo = command('turbo-version', turbo, ['--version']).stdout.trim();
  assert.equal(report.turbo, '2.11.7');
  const all = new Set(expectedIds());
  report.sourceInvalidationPolicy = 'Observed with the root ownership declarations intact: the existing testkit API edit follows its manifest closure (one miss, 12 unrelated hits). Adding a testkit source module, editing browser CSS, and changing committed WASM bytes change the root internal-dependency global identity and conservatively invalidate all 13 builds. This report describes those fixtures, not a universal selectivity guarantee.';
  const baselineHashes = dryHashes('baseline');
  const cold = runBuild('cold');
  expectCache(cold, all);
  const baseline = outputInventory();
  assert.ok(Object.keys(baseline).length > 100, 'real emitted inventory required');
  for (const owner of owners.values()) assert.ok(Object.keys(baseline).some(file => file.startsWith(`${relative(workspace, owner.directory)}/dist/`)), `${owner.manifest.name}: no emitted distribution`);
  for (const suffix of ['.js', '.d.ts', '.js.map', '.d.ts.map', '.wasm', '.tsbuildinfo']) assert.ok(Object.keys(baseline).some(file => file.endsWith(suffix)), `missing ${suffix} output coverage`);
  assert.ok(baseline['packages/ui/dist/browser/can-style.css'], 'browser assets must be included');
  const executable = guarded(join(workspace, 'packages/cloudflare/dist/cli/platform.js'));
  assert.ok((statSync(executable).mode & 0o111) !== 0, 'cold CLI build must emit executable mode');
  save('cold.inventory.json', baseline);
  expectCache(runBuild('unchanged-warm'));
  assertInventory(baseline, 'unchanged-warm');
  cleanOutputs();
  assert.deepEqual(outputInventory(), {}, 'complete output/incremental deletion required');
  expectCache(runBuild('full-restore'));
  assertInventory(baseline, 'full-restore');
  const incremental = Object.entries(baseline).filter(([file]) => file.endsWith('.tsbuildinfo'));
  cleanOutputs(false);
  assert.deepEqual(Object.entries(outputInventory()), incremental, 'retained incremental metadata fixture required');
  expectCache(runBuild('dist-only-restore'));
  assertInventory(baseline, 'dist-only-restore');
  // Do not rely on existing mode: remove this cached output after changing it.
  // The cache extraction must recreate its mode from the archived build.
  chmodSync(executable, 0o644);
  rmSync(executable);
  expectCache(runBuild('executable-restore'));
  assertInventory(baseline, 'executable-restore');
  const contracts = guarded(join(owners.get('@canlang/contracts').directory, 'src/index.ts'));
  const contractBytes = readFileSync(contracts);
  writeFileSync(contracts, Buffer.concat([contractBytes, Buffer.from('\nexport const turboCacheProof = "upstream-api-change" as const;\n')]));
  const closure = dependentsOf('@canlang/contracts');
  const mutated = runBuild('upstream-api-change');
  expectCache(mutated, closure);
  const mutatedInventory = outputInventory();
  assert.notDeepEqual(mutatedInventory, baseline, 'upstream API mutation must really change emitted bytes');
  save('mutated.inventory.json', mutatedInventory);
  cleanOutputs();
  const rebuilt = runBuild('mutated-uncached-rebuild', { uncached: true });
  for (const task of rebuilt.tasks) assert.notEqual(task.cache.status, 'HIT', 'cache-disabled rebuild must execute');
  assertInventory(mutatedInventory, 'mutated-uncached-rebuild');
  writeFileSync(contracts, contractBytes);
  cleanOutputs();
  expectCache(runBuild('baseline-restore'));
  assertInventory(baseline, 'baseline-restore');
  // Catalog generation and packaged preparation binaries have separate owners.
  // A real producer execution preserves them, and its archive excludes them.
  const separatelyOwned = [
    'packages/values/dist/catalog.json',
    ...['can-preparation', 'can-preparation.exe', 'manifest.json'].map(file => `packages/cloudflare/dist/preparation/cache-proof-host/${file}`),
  ];
  for (const file of separatelyOwned) {
    const destination = guarded(join(workspace, file));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `separately owned cache proof: ${file}\n`);
  }
  const ownershipRun = runBuild('separate-owner-preservation', { force: true });
  for (const task of ownershipRun.tasks) assert.notEqual(task.cache.status, 'HIT', 'ownership probe must execute all producers');
  for (const file of separatelyOwned) assert.equal(readFileSync(join(workspace, file), 'utf8'), `separately owned cache proof: ${file}\n`, `producer cleaner removed separate output: ${file}`);
  cleanOutputs();
  expectCache(runBuild('separate-owner-cache-exclusion'));
  assertInventory(baseline, 'separate-owner-cache-exclusion');
  for (const file of separatelyOwned) assert.equal(existsSync(join(workspace, file)), false, `build archive captured separately owned output: ${file}`);
  report.probes.push({ name: 'separate-output-ownership', preservedByProducerAndExcludedFromCache: separatelyOwned });
  const leaf = '@canlang/testkit';
  const leafFile = guarded(join(owners.get(leaf).directory, 'src/index.ts'));
  const leafBytes = readFileSync(leafFile);
  const deletionFixture = guarded(join(owners.get(leaf).directory, 'src/__turbo_cache_deletion_proof__.ts'));
  assert.equal(existsSync(deletionFixture), false, 'scratch deletion fixture must not replace an active source');
  try {
    writeFileSync(leafFile, Buffer.concat([leafBytes, Buffer.from('\nexport const turboLeafProof = true;\n')]));
    const leafClosure = dependentsOf(leaf);
    assert.ok(leafClosure.size < owners.size, 'leaf probe must distinguish manifest graph closure from global invalidation');
    const leafApiRun = runBuild('leaf-api-change');
    expectCache(leafApiRun, leafClosure);
    assert.equal(leafApiRun.globalCacheInputs.hashOfInternalDependencies, cold.globalCacheInputs.hashOfInternalDependencies, 'existing-file leaf API edit should retain the root file inventory identity');
    report.probes.push({ name: 'leaf-api-change', changed: [...leafClosure], unrelatedWarmHits: owners.size - leafClosure.size });
    writeFileSync(deletionFixture, 'export const removalProof = "must disappear after source deletion";\n');
    const leafRun = runBuild('leaf-source-change');
    expectCache(leafRun, all);
    assert.notEqual(leafRun.globalCacheInputs.hashOfInternalDependencies, cold.globalCacheInputs.hashOfInternalDependencies, 'leaf source must invalidate the root internal-dependency hash');
    const explicitInputChanges = cacheableTasks(leafRun).filter(task => JSON.stringify(task.inputs) !== JSON.stringify(cacheableTasks(cold).find(before => before.taskId === task.taskId).inputs)).map(task => task.taskId);
    assert.deepEqual(explicitInputChanges, [`${leaf}#build`], 'only the leaf owner should have changed explicit task inputs');
    report.probes.push({ name: 'leaf-source-change', changed: [...all], manifestDependencyClosure: [...leafClosure], explicitInputChanges, unrelatedWarmHits: 0, cause: 'new source file changes the root internal workspace file inventory hash' });
    const removedOutputs = ['.js', '.d.ts', '.js.map', '.d.ts.map'].map(extension => join(owners.get(leaf).directory, `dist/__turbo_cache_deletion_proof__${extension}`));
    for (const file of removedOutputs) assert.ok(existsSync(file), `deletion fixture must actually emit: ${file}`);
    writeFileSync(leafFile, leafBytes);
    rmSync(deletionFixture);
    expectCache(runBuild('source-rollback-with-extra-outputs'));
    assertInventory(baseline, 'source-rollback-with-extra-outputs');
    for (const file of removedOutputs) assert.equal(existsSync(file), false, `B-only output survived cached rollback to A: ${file}`);
    report.probes.push({ name: 'A-B-A-rollback-without-manual-output-cleaning', cachedBuildHits: 13, actualPreparationExecutions: 13, absentOutputs: removedOutputs.map(file => relative(workspace, file)) });
    writeFileSync(leafFile, Buffer.concat([leafBytes, Buffer.from('\nexport const turboLeafProof = true;\n')]));
    writeFileSync(deletionFixture, 'export const removalProof = "must disappear after source deletion";\n');
    expectCache(runBuild('leaf-extra-output-cache-restore'));
    for (const file of removedOutputs) assert.ok(existsSync(file), `B cache must actually restore its additional module: ${file}`);
    rmSync(deletionFixture);
    writeFileSync(leafFile, Buffer.concat([leafBytes, Buffer.from('\nexport const turboLeafProof = "source-deleted" as const;\n')]));
    expectCache(runBuild('leaf-source-deletion'), leafClosure);
    for (const file of removedOutputs) assert.equal(existsSync(file), false, `stale output survived source deletion: ${file}`);
    report.probes.push({ name: 'leaf-source-deletion', changed: [...leafClosure], unrelatedWarmHits: owners.size - leafClosure.size, absentOutputs: removedOutputs.map(file => relative(workspace, file)) });
  } finally { writeFileSync(leafFile, leafBytes); rmSync(deletionFixture, { force: true }); }
  // Revert to the previously cached A source without deleting B outputs first.
  // The uncached preparation tasks must remove B-only artifacts before A hits.
  expectCache(runBuild('source-rollback-without-preclean'));
  assertInventory(baseline, 'source-rollback-without-preclean');
  fileHashProbe('lock-change', join(workspace, 'bun.lock'), bytes => Buffer.concat([bytes, Buffer.from('\n')]), all, baselineHashes);
  fileHashProbe('shared-config-change', join(workspace, 'tsconfig.base.json'), bytes => Buffer.concat([bytes, Buffer.from('\n')]), all, baselineHashes);
  fileHashProbe('browser-source-change', join(workspace, 'packages/ui/themes.css'), bytes => Buffer.concat([bytes, Buffer.from('\n/* cache input probe */\n')]), all, baselineHashes);
  fileHashProbe('generated-wasm-change', join(workspace, 'packages/values/bindings/generated/values_semantics_bg.wasm'), bytes => { const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; return changed; }, all, baselineHashes);
  const config = JSON.parse(readFileSync(join(workspace, 'turbo.json'), 'utf8'));
  const identityVariables = [...new Set([...(config.globalEnv ?? []), ...(config.tasks.build.env ?? [])])].filter(key => key.startsWith('CAN_'));
  assert.ok(identityVariables.length >= 3, 'platform, Node and Bun identities must participate in task hashing');
  for (const key of identityVariables) {
    assert.ok(environment[key], `identity environment is absent: ${key}`);
    const changed = changedHashes(baselineHashes, dryHashes(`identity-${key}`, { ...environment, [key]: `${environment[key]}-cache-proof` }));
    assert.deepEqual(changed, [...all].sort(), `${key} does not invalidate all build identities`);
    report.probes.push({ name: `identity-${key}`, changed });
  }
  for (const [key, value] of [['NODE_ENV', environment.NODE_ENV === 'production' ? 'development' : 'production'], ['TZ', environment.TZ === 'UTC' ? 'Europe/Brussels' : 'UTC']]) {
    const changed = changedHashes(baselineHashes, dryHashes(`environment-${key}`, { ...environment, [key]: value }));
    assert.deepEqual(changed, [...all].sort(), `${key} does not invalidate configured build environments`);
    report.probes.push({ name: `environment-${key}`, changed });
  }
  // A real failing producer must prevent every dependent from executing.
  try {
    writeFileSync(contracts, Buffer.concat([contractBytes, Buffer.from('\nexport const turboBrokenProducer: never = 1;\n')]));
    const failed = runBuild('producer-failure', { expectedFailure: true });
    const producer = failed.tasks.find(task => task.taskId === '@canlang/contracts#build');
    assert.ok(producer.execution?.exitCode > 0, 'contracts producer must execute and fail compilation');
    for (const id of closure) {
      if (id === producer.taskId) continue;
      const task = failed.tasks.find(task => task.taskId === id);
      assert.ok(!task || task.execution == null || task.execution.exitCode == null, `dependent executed despite failed producer: ${id}`);
    }
    report.probes.push({ name: 'producer-failure', blockedDependents: [...closure].filter(id => id !== producer.taskId) });
  } finally { writeFileSync(contracts, contractBytes); }
  report.result = 'passed';
  save('report.json', report);
  console.log(`Turbo cache verification passed. Evidence: ${join(evidence, 'report.json')}`);
} catch (error) {
  report.result = 'failed';
  report.error = error.stack;
  save('report.json', report);
  console.error(`Turbo cache verification failed. Scratch preserved: ${scratch}`);
  throw error;
}
