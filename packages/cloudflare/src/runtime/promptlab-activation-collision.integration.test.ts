/** Actual copied PromptLab source/saved revision collision refusal in isolated
 * State memory. This is not deployment, successful activation, or a host gate.
 * Generic migration/rollback coverage remains with State's existing tests. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { CompileArtifact, InstalledSnapshot, MigrationTransition } from '@canlang/contracts';
import { distribution } from '@canlang/values/distribution';
import { StateError } from '@canlang/state/errors';
import type { ModelTable } from '@canlang/state/mutation/models';
import { givenUniqueKeyName } from '@canlang/state/effects/staging';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { validateTransition } from '@canlang/state/migration/transition';
import { stageNextChunk } from '@canlang/state/migration/stage';
import { validateStaged } from '@canlang/state/migration/validate';
import { activate } from '@canlang/state/migration/activate';
import { FIXED_NOW, asModel, asOperationId, asRevision, createMemoryIdentityStore,
  makeIdentity, seedMember, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { discoverGeneratedClosure, snapshotGeneratedClosure } from './native-dev.test-support.js';
import { parseArtifactText } from './artifact.js';
import { assembleModules } from './modules.js';
import { loadCanonicalDescriptors } from './invoke.js';
import { buildInvoker } from '../worker/assembly.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const compiler = join(root, 'compiler/target/debug/can');
const liveSource = join(root, 'draft/apps/CanPromptLab/CanPromptLab.can');
const run = promisify(execFile);
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

async function compile(project: string): Promise<{ artifact: CompileArtifact; digest: string }> {
  const result = await run(compiler, ['compile', '--format=json', '--native-scenario-receipts',
    `--catalog=${fileURLToPath(distribution.catalog)}`, basename(liveSource)], {
    cwd: project, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  return { artifact: parseArtifactText(result.stdout, join(project, 'compiled.artifact.json')).artifact,
    digest: digest(result.stdout) };
}

async function generationRequest(project: string, operation: 'edit.begin' | 'edit.end', params: Record<string, unknown>) {
  const request = join(project, `${operation}.json`);
  await writeFile(request, JSON.stringify({ version: 1, request_id: `activation-${operation}`, operation, root: project, ...params }));
  const env: NodeJS.ProcessEnv = { ...process.env, CAN_COMPILER_BIN: compiler,
    CAN_PLATFORM_BIN: join(root, 'packages/cloudflare/dist/cli/platform.js') };
  delete env.CAN_GENERATION_COMPILER_ONLY;
  const result = await run(compiler, ['gen', '--request', request], {
    cwd: root, env, timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(envelope.ok, true, result.stdout);
  return envelope;
}

test('actual PromptLab candidate key collision refuses activation and preserves predecessor state and claims', { timeout: 180_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'can-promptlab-activation-'));
  try {
    const closure = await discoverGeneratedClosure(compiler, root, liveSource);
    const inputs = await snapshotGeneratedClosure(root, liveSource, closure);
    const predecessor = join(temporary, 'predecessor'), candidate = join(temporary, 'candidate');
    for (const project of [predecessor, candidate]) {
      for (const input of inputs) {
        const path = relative(dirname(liveSource), resolve(root, input.path));
        assert.ok(path !== '' && !path.startsWith('..'), 'all copied inputs belong to the actual app saved closure');
        const destination = join(project, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, input.bytes);
      }
    }
    const records = inputs.filter(input => input.path.endsWith('/unit.json')).map(input => ({
      bytes: input.bytes, record: JSON.parse(input.bytes.toString('utf8')) as {
        id: string; source: { owner: string; kind: string; label: string }; contract: unknown; original: unknown; provenance: unknown;
      },
    }));
    const keywords = records.filter(({ record }) => record.source.owner === 'prompt_lab' &&
      record.source.kind === 'keyword' && record.source.label === 'canonical_identity');
    assert.equal(keywords.length, 1);
    const keyword = keywords[0]!, implementation = join('can.generated', keyword.record.id, 'implementation.js');
    const editing = await generationRequest(candidate, 'edit.begin', { paths: [implementation] });
    assert.equal(typeof editing.token, 'string');
    try {
      await writeFile(join(candidate, implementation),
        'export function canonicalKey(value) { return value.normalize("NFKC").toLowerCase(); }\n');
    } finally {
      await generationRequest(candidate, 'edit.end', { token: editing.token });
    }
    // The edit changes only copied behavior. Its source association, original
    // provenance and original-byte record remain truthful and untouched.
    for (const project of [predecessor, candidate]) {
      assert.deepEqual(await readFile(join(project, 'can.generated', keyword.record.id, 'unit.json')), keyword.bytes);
      assert.deepEqual(await readFile(join(project, basename(liveSource))),
        inputs.find(input => resolve(root, input.path) === liveSource)!.bytes);
    }
    const beforeCompile = await compile(predecessor), afterCompile = await compile(candidate);
    assert.notEqual(beforeCompile.digest, afterCompile.digest);
    const beforeArtifact = beforeCompile.artifact, afterArtifact = afterCompile.artifact;
    assert.deepEqual(beforeArtifact.sources, afterArtifact.sources);
    assert.deepEqual(beforeArtifact.models, afterArtifact.models);
    const originalRules = beforeArtifact.givenContracts!.keywords.filter(rule => rule.unitId === keyword.record.id);
    const candidateRules = afterArtifact.givenContracts!.keywords.filter(rule => rule.unitId === keyword.record.id);
    assert.equal(originalRules.length, 2, 'actual reused Entry and Tag applications');
    assert.equal(candidateRules.length, originalRules.length);
    for (const [index, original] of originalRules.entries()) {
      const changed = candidateRules[index]!;
      assert.notEqual(original.fingerprint, changed.fingerprint);
      assert.deepEqual({ ...original, fingerprint: '' }, { ...changed, fingerprint: '' });
    }
    const assemble = (artifact: CompileArtifact, project: string) => assembleModules({ artifact, sourcePath: join(project, basename(liveSource)) }, {
      workDir: join(project, 'assembled'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    const beforeAssembly = await assemble(beforeArtifact, predecessor), afterAssembly = await assemble(afterArtifact, candidate);
    // This is the canonical native loader's actual joined model table, including
    // saved field checks and computed-key export/fingerprint correspondence.
    const oldModels = (await loadCanonicalDescriptors(beforeAssembly, beforeArtifact)).table as ModelTable;
    const desiredModels = (await loadCanonicalDescriptors(afterAssembly, afterArtifact)).table as ModelTable;
    const tag = asModel('prompt_lab.Tag');
    const oldRule = oldModels.get(tag)!.givenUniqueKeys![0]!, newRule = desiredModels.get(tag)!.givenUniqueKeys![0]!;
    assert.equal(await oldRule.evaluate('É'), 'É'); assert.equal(await oldRule.evaluate('é'), 'é');
    assert.equal(await newRule.evaluate('É'), 'é'); assert.equal(await newRule.evaluate('é'), 'é');
    const { store } = createTestMemoryStorage();
    const memberships = createMemoryIdentityStore();
    const member = await seedMember(memberships, { isOwner: false, roles: ['prompt_lab.curator'] });
    const identity = makeIdentity({ membership: member.membership, email: member.user.email });
    const invoker = buildInvoker(beforeArtifact, beforeAssembly, store, { memberships, now: () => FIXED_NOW });
    for (const [index, name] of ['É', 'é'].entries()) {
      const outcome = await invoker.invokeMutation({ operation: 'prompt_lab.add_tag',
        operation_id: asOperationId(uuidv7(FIXED_NOW, index + 1)), inputs: { name, description: 'Actual predecessor key' } }, identity);
      assert.ok('result' in outcome, JSON.stringify(outcome));
      assert.equal(outcome.result.status, 'committed');
    }
    const revision = await store.readRevision();
    const installed: InstalledSnapshot = { owner: 'prompt_lab', snapshotId: `predecessor-${beforeCompile.digest}`,
      digest: beforeCompile.digest, installedRevision: asRevision(Number(revision) + 1), installedAt: FIXED_NOW };
    await store.flipInstalledSnapshot({ expectedRevision: revision, migrationId: 'activation-seed', owner: installed.owner,
      snapshot: installed, renameFromOwner: null, invalidatedIntentIds: [], outcomes: [] });
    const transition: MigrationTransition = { migrationId: 'promptlab-colliding-candidate', owner: installed.owner,
      fromSnapshotId: installed.snapshotId, fromDigest: installed.digest, toSnapshotId: `candidate-${afterCompile.digest}`,
      toDigest: afterCompile.digest, bodyDigest: digest('[]'), directives: [] };
    const plan = validateTransition(installed, transition, oldModels, desiredModels);
    const staged = await stageNextChunk({ store, plan, oldModels, desiredModels, mappers: new Map(), chunkSize: 10 });
    assert.equal(staged.done, true);
    assert.equal((await store.readStagedRows(plan.migrationId, null, 10)).length, 0, 'code-only change retains actual stored data');
    const snapshot = async () => {
      const models = await Promise.all([...oldModels.keys()].map(async model => {
        const rows = await store.query({ model, authority: 'owner', archived: 'include' });
        return { model, rows, history: await Promise.all(rows.map(row => store.historyFor(model, row.id))) };
      }));
      return { models, installed: await store.readInstalledSnapshot(installed.owner),
        claims: await Promise.all(['É', 'é'].map(key => store.uniqueOwner!(tag, givenUniqueKeyName(oldRule.rule), key))),
        revision: await store.readRevision(), outbox: await store.outboxPending() };
    };
    const prior = await snapshot();
    assert.equal(prior.models.find(model => model.model === tag)!.rows.length, 2);
    assert.ok(prior.claims.every(owner => owner !== null)); assert.notEqual(prior.claims[0], prior.claims[1]);
    await assert.rejects(validateStaged({ store, plan, oldModels, desiredModels, oldLocks: new Map() }),
      error => error instanceof StateError && error.code === 'validation' && /duplicate computed-key value/.test(error.message));
    assert.equal((await store.readMigrationProgress(plan.migrationId))?.phase, 'staging');
    await assert.rejects(activate({ store, plan, oldModels, desiredModels, inventory: [], chunkSize: 10,
      clock: { nowMs: () => FIXED_NOW } }), /needs a staged set/);
    assert.deepEqual(await snapshot(), prior, 'failed candidate cannot publish rows, history, claims, sources or installed pointer');
    // The real source's later model-rule activation phase and successful
    // deployment/host release are separate; this negative stops at uniqueness.
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
