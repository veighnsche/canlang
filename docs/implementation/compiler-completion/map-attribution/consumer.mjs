import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {registerHooks, SourceMap} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const [root, artifactPath, sourcePath, workDir] = process.argv.slice(2);
assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'requires actual Node >=24 native TS stripping');
const registryMappedOutcome = process.argv.includes('--registry-mapped-outcome');
const canonicalMappedOutcome = process.argv.includes('--canonical-mapped-outcome');
if (!registryMappedOutcome && !canonicalMappedOutcome) assert.ok(process.execArgv.includes('--enable-source-maps'));
// Resolve source-owned .js imports to their existing TypeScript owners. This
// changes no emitted module, producer import or source-map coordinate.
registerHooks({resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(candidate)) return {url:candidate.href, shortCircuit:true};
  }
  return next(specifier, context);
}});
const runtime = join(root, 'packages/cloudflare/src/runtime');
const {loadArtifactFile} = await import(pathToFileURL(join(runtime, 'artifact.ts')));
const {assembleModules} = await import(pathToFileURL(join(runtime, 'modules.ts')));
const loaded = loadArtifactFile(artifactPath);
if (canonicalMappedOutcome) {
  assert.ok(!process.execArgv.includes('--enable-source-maps'), 'runtime mapper consumes actual generated frames');
  const artifact = loaded.artifact;
  assert.equal(artifact.sources[0].path, sourcePath);
  assert.equal(artifact.sources[0].sha256, createHash('sha256').update(readFileSync(sourcePath, 'utf8')).digest('hex'));
  // The generated handler and canonical invoker share their installed
  // runtime owner, including its native record bindings.
  const assembly = await assembleModules(loaded, {
    workDir, stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
  });
  const {invokeMutationCanonical} = await import('@canlang/cloudflare/runtime/invoke');
  const {buildInvoker} = await import('@canlang/cloudflare/worker/assembly');
  const {StateError} = await import('@canlang/state/errors');
  const {createTestMemoryStorage} = await import('@canlang/state/storage/memory');
  const {FIXED_NOW, asModel, createMemoryIdentityStore, seedMember, makeIdentity, uuidv7} =
    await import('@canlang/state/testing/invocation/fixtures');
  const {store} = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, {isOwner:false});
  const identity = makeIdentity({membership:member.membership, email:member.user.email});
  const operation = 'Attribution.fail';
  const inputs = {numerator:'9', denominator:'0'};
  const mapped = {source:sourcePath, line:4, column:8, name:'Attribution.remainder'};
  // Observe native commits without replacing storage behavior. Failed staged
  // creates must never reach either the domain writes or history batch.
  const commits = [];
  const nativeCommit = store.commit.bind(store);
  store.commit = async batch => {
    const result = await nativeCommit(batch);
    commits.push(batch);
    return result;
  };
  async function rejected(asm, operationId, details, checkedArtifact=artifact) {
    let failure;
    try {
      await invokeMutationCanonical({
        asm, artifact:checkedArtifact, operation, operationId, inputs, identity,
        app:'Attribution', source:'worker', store, memberships, now:()=>FIXED_NOW,
      });
    } catch (error) { failure = error; }
    assert.ok(failure instanceof StateError);
    assert.equal(failure.code, 'rule_failed');
    assert.equal(failure.message, 'Division by zero');
    assert.deepEqual(failure.details, details);
    const receipt = await store.readReceipt({
      app:'Attribution', owner:identity.team.team_id, principal:identity.actor.user_id,
      operation, operationId,
    });
    assert.ok(receipt);
    assert.deepEqual(receipt.outcome, {status:'rejected', code:'rule_failed', message:'Division by zero'});
    for (const key of ['details', 'mapped', 'cause', 'source']) assert.equal(Object.hasOwn(receipt, key), false);
    assert.deepEqual(await store.query({model:asModel('Attribution.Attempt'), authority:'owner'}), []);
    return receipt;
  }
  const operationId = uuidv7(FIXED_NOW, 1);
  await rejected(assembly, operationId, {mapped});
  const invoker = buildInvoker(artifact, assembly, store, {memberships, now:()=>FIXED_NOW});
  const publicOutcome = await invoker.invokeMutation({operation, operation_id:operationId, inputs}, identity);
  assert.deepEqual(publicOutcome, {error:{
    code:'rule_failed', message:'Division by zero', operation_id:operationId, retryable:false,
  }});
  // Removing only map URLs still leaves the mapper's real artifact fallback.
  // This host has neither staged nor artifact maps; emitted JS is unchanged.
  const unmappedArtifact = {...artifact, modules:artifact.modules.map(({map,...module})=>module)};
  await rejected({...assembly, mapUrls:{}, sourceMaps:{}}, uuidv7(FIXED_NOW, 2), null, unmappedArtifact);
  assert.equal(commits.length, 2, 'only the two actual rejected receipts commit');
  for (const batch of commits) {
    assert.deepEqual(batch.writes, []);
    assert.deepEqual(batch.history, []);
    assert.deepEqual(batch.outbox, []);
    assert.deepEqual(batch.schedules, []);
    assert.deepEqual(batch.uniqueClaims, []);
    assert.deepEqual(batch.uniqueReleases, []);
  }
  console.log(JSON.stringify({consumer:'real CLI → public loader/assembler → installed canonical runtime → installed State Memory',
    liveMapped:mapped, absentMapDetails:null, rollback:true, publicOutcome}));
  process.exit(0);
}
if (registryMappedOutcome) {
  assert.ok(!process.execArgv.includes('--enable-source-maps'), 'runtime mapper consumes actual generated frames');
  const assembly = await assembleModules(loaded, {workDir, stdlibUrl:import.meta.resolve('@canlang/stdlib')});
  const {invokeCallable} = await import(import.meta.resolve('@canlang/cloudflare/runtime/invoke'));
  const outcome = await invokeCallable(assembly, loaded.artifact, 'Attribution.remainder', {}, [9n, 0n]);
  assert.deepEqual(outcome, {ok:false, error:'Division by zero', mapped:{source:sourcePath, line:4, column:8, name:'Attribution.remainder'}});
  console.log(JSON.stringify({consumer:'real CLI → public artifact loader/assembler → installed runtime invokeCallable registry → mapped failure outcome', outcome}));
  process.exit(0);
}
const before = JSON.stringify(loaded.artifact);
const sourceText = readFileSync(sourcePath, 'utf8');
const artifact = loaded.artifact;
assert.equal(artifact.modules.length, 1);
assert.equal(artifact.sources[0].path, sourcePath);
assert.equal(artifact.sources[0].sha256, createHash('sha256').update(sourceText).digest('hex'));
// Real installed producer exports; no test runtime or injection facade.
const stdlibUrl = import.meta.resolve('@canlang/stdlib');
const assembly = await assembleModules(loaded, {workDir, stdlibUrl});
assert.equal(JSON.stringify(artifact), before, 'assembler preserves compiler artifact bytes/values');
const descriptor = artifact.callables.find(item => item.id === 'Attribution.remainder');
assert.ok(descriptor);
const entry = await import(assembly.moduleUrls[descriptor.module]);
let callable = entry.canApp();
for (const member of descriptor.member) callable = callable[member];
assert.equal(typeof callable, 'function');
assert.equal(await callable({}, 9n, 4n), 1n, 'ordinary positive control uses emitted call semantics');
let failure;
try { await callable({}, 9n, 0n); } catch (error) { failure = error; }
assert.ok(failure instanceof RangeError);
assert.equal(failure.message, 'Division by zero');
// Independently fixed original anchor: the derive expression is on source line
// four. Existing Can point maps choose its owning declaration at its name (byte column seven).
assert.ok(failure.stack.includes(`${sourcePath}:4:8`), failure.stack);
const sourceIdentity = value => value.startsWith('file:') ? fileURLToPath(value) : value;
const stagedPath = fileURLToPath(assembly.moduleUrls[descriptor.module]);
const stagedJs = readFileSync(stagedPath, 'utf8');
const generatedLine = stagedJs.split('\n').findIndex(line => line.includes(' % '));
assert.ok(generatedLine >= 0);
// Node's SourceMap is an independent engine, not the Rust or package decoder.
// Both the raw compiler map and the actual staged map must identify authored
// source text and the same fixed source location.
for (const map of [artifact.modules[0].map, JSON.parse(readFileSync(fileURLToPath(assembly.mapUrls[descriptor.module]), 'utf8'))]) {
  assert.deepEqual(map.sources, [sourcePath]);
  assert.deepEqual(map.sourcesContent, [sourceText]);
  const decoded = new SourceMap(map).findEntry(generatedLine, 0);
  assert.equal(sourceIdentity(decoded.originalSource), sourcePath);
  assert.equal(decoded.originalLine, 3);
  assert.equal(decoded.originalColumn, 7);
}
console.log(JSON.stringify({node:process.versions.node, consumer:'real CLI → public artifact loader/assembler → installed producers → emitted pure callable → Node source-map engine', positive:'9 % 4 = 1', failure:failure.message, location:`${sourcePath}:4:8`, rawAndStagedMap:true, unchangedArtifact:true}));
