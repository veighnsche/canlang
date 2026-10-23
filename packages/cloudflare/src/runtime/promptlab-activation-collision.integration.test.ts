/** Actual copied PromptLab rules: collision refusal plus bounded computed-key
 * exchange and durable recovery in real D1/DO SQLite. This does not activate a deployment
 * or establish a host migration gate. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { CompileArtifact, InstalledSnapshot, MigrationPhase, MigrationTransition,
  PublishMigrationChunk, StoragePort } from '@canlang/contracts';
import type { D1Database } from '@cloudflare/workers-types';
import { Miniflare } from 'miniflare';
import { distribution } from '@canlang/values/distribution';
import { StateError } from '@canlang/state/errors';
import type { ModelTable } from '@canlang/state/mutation/models';
import { givenUniqueKeyName } from '@canlang/state/effects/staging';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { abortMigration, resumeMigration, type MigrationMapper } from '@canlang/state/migration';
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

let generationSequence = 0;
async function generationRequest(project: string, operation: 'edit.begin' | 'edit.end', params: Record<string, unknown>) {
  const requestId = `activation-${operation}-${++generationSequence}`;
  const request = join(project, `${requestId}.json`);
  await writeFile(request, JSON.stringify({ version: 1, request_id: requestId, operation, root: project, ...params }));
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

test('actual PromptLab collision refuses while computed-key exchanges recover across durable chunks', { timeout: 180_000 }, async () => {
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
    // Re-edit the same copied, source-associated keyword into a permutation:
    // the final target is unique although each first claim belongs to the
    // other row until that row's later chunk releases it.
    const swapping = await generationRequest(candidate, 'edit.begin', { paths: [implementation] });
    try {
      await writeFile(join(candidate, implementation),
        'export function canonicalKey(value) { return value === "É" ? "é" : value === "é" ? "É" : value; }\n');
    } finally {
      await generationRequest(candidate, 'edit.end', { token: swapping.token });
    }
    assert.deepEqual(await readFile(join(candidate, 'can.generated', keyword.record.id, 'unit.json')), keyword.bytes);
    const exchangeCompile = await compile(candidate);
    const exchangeAssembly = await assembleModules({ artifact: exchangeCompile.artifact,
      sourcePath: join(candidate, basename(liveSource)) }, { workDir: join(candidate, 'assembled-exchange'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    const exchangeModels = (await loadCanonicalDescriptors(exchangeAssembly, exchangeCompile.artifact)).table as ModelTable;
    const exchangeRule = exchangeModels.get(tag)!.givenUniqueKeys![0]!;
    assert.equal(await exchangeRule.evaluate('É'), 'é'); assert.equal(await exchangeRule.evaluate('é'), 'É');
    assert.equal(await exchangeRule.evaluate('unchanged'), 'unchanged');
    assert.deepEqual(exchangeCompile.artifact.sources, beforeArtifact.sources);
    assert.deepEqual(exchangeCompile.artifact.models, beforeArtifact.models);
    const memoryExchange = validateTransition(installed, { ...transition,
      migrationId: 'promptlab-memory-exchange', toSnapshotId: `exchange-${exchangeCompile.digest}`,
      toDigest: exchangeCompile.digest }, oldModels, exchangeModels);
    await stageNextChunk({ store, plan: memoryExchange, oldModels, desiredModels: exchangeModels,
      mappers: new Map(), chunkSize: 1 });
    await validateStaged({ store, plan: memoryExchange, oldModels, desiredModels: exchangeModels, oldLocks: new Map() });
    assert.equal((await activate({ store, plan: memoryExchange, oldModels, desiredModels: exchangeModels,
      inventory: [], chunkSize: 1, clock: { nowMs: () => FIXED_NOW } })).flipped, true);
    const memoryCompleted = await snapshot();
    assert.deepEqual(memoryCompleted.models, prior.models);
    assert.deepEqual(memoryCompleted.claims, [prior.claims[1], prior.claims[0]]);
    const phases = ['releasing-claims', 'publishing-rows', 'retaining-claims'] as const;
    const modes = [{ phase: null, acknowledgement: 'none', staged: false, adapter: 'd1' } as const,
      ...phases.flatMap(phase => ([{ phase, acknowledgement: 'before', staged: false, adapter: 'd1' },
        { phase, acknowledgement: 'after', staged: false, adapter: 'd1' }] as const)),
      { phase: null, acknowledgement: 'none', staged: true, adapter: 'd1' } as const,
      { phase: 'publishing-rows', acknowledgement: 'after', staged: true, adapter: 'd1' } as const,
      { phase: null, acknowledgement: 'none', staged: true, adapter: 'do' } as const];
    for (const [modeIndex, mode] of modes.entries()) {
      const persistent = join(temporary, `d1-exchange-${modeIndex}`);
      const start = () => new Miniflare({ modules: true, compatibilityDate: '2026-07-15',
        ...(mode.adapter === 'd1' ? {
          script: 'export default {fetch(){return new Response("ready")}}',
          d1Databases: { DB: 'promptlab-key-exchange' }, d1Persist: persistent,
        } : {
          scriptPath: join(root, 'packages/state/dist/test/storage/do-test-worker.js'),
          durableObjects: { TEST_DO: { className: 'TestDO', useSQLite: true } }, durableObjectsPersist: persistent,
        }) });
      let runtime = start();
      try {
        const open = async (): Promise<StoragePort> => {
          if (mode.adapter === 'd1') {
            const db = await runtime.getD1Database('DB') as unknown as D1Database;
            await ensureSchema(db);
            return createD1Storage(db);
          }
          // Existing State test worker owns real DO SQLite and the adapter;
          // this caller only transports the ordinary StoragePort protocol.
          return new Proxy({} as StoragePort, { get(_target, property) {
            if (typeof property !== 'string' || typeof Reflect.get(store, property) !== 'function') return undefined;
            return async (...args: unknown[]) => {
              const response = await runtime.dispatchFetch('https://migration.test/call', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: property, args }),
              });
              const result = await response.json() as { ok: boolean; value: unknown; error?: { name: string; message: string } };
              assert.equal(response.status, 200);
              if (!result.ok) throw new Error(`${result.error?.name}: ${result.error?.message}`);
              return result.value;
            };
          } });
        };
        let durable = await open();
        const seed = buildInvoker(beforeArtifact, beforeAssembly, durable, { memberships, now: () => FIXED_NOW });
        for (const [index, name] of ['É', 'é', 'unchanged'].entries()) {
          const outcome = await seed.invokeMutation({ operation: 'prompt_lab.add_tag',
            operation_id: asOperationId(uuidv7(FIXED_NOW, index + 1)),
            inputs: { name, description: 'Persisted predecessor key' } }, identity);
          assert.ok('result' in outcome, JSON.stringify(outcome));
          assert.equal(outcome.result.status, 'committed');
        }
        const seededRevision = await durable.readRevision();
        const predecessorSnapshot: InstalledSnapshot = { ...installed,
          installedRevision: asRevision(Number(seededRevision) + 1) };
        await durable.flipInstalledSnapshot({ expectedRevision: seededRevision, migrationId: 'durable-exchange-seed',
          owner: predecessorSnapshot.owner, snapshot: predecessorSnapshot, renameFromOwner: null,
          invalidatedIntentIds: [], outcomes: [] });
        const desired = mode.staged ? oldModels : exchangeModels;
        const mapper: MigrationMapper = (before, row) => {
          row.set('name', before.data.name === 'É' ? 'é' : before.data.name === 'é' ? 'É' : before.data.name);
        };
        const mappers = mode.staged ? new Map([[tag, mapper]]) : new Map();
        // Mapper intake is the existing interim engine API; source-compiled
        // computed rules and actual rows remain real. This is no native host
        // migration declaration or deployment admission claim.
        const exchangePlan = validateTransition(predecessorSnapshot, { ...transition,
          migrationId: `promptlab-durable-exchange-${modeIndex}`,
          toSnapshotId: `exchange-${modeIndex}-${mode.staged ? beforeCompile.digest : exchangeCompile.digest}`,
          toDigest: mode.staged ? beforeCompile.digest : exchangeCompile.digest,
          bodyDigest: mode.staged ? digest(mapper.toString()) : transition.bodyDigest,
          directives: mode.staged ? [{ kind: 'backfill', model: tag }] : [],
        }, oldModels, desired);
        assert.equal(exchangePlan.models.get(tag)?.needsStaging, mode.staged);
        let stagedDone = false;
        for (let chunk = 0; !stagedDone && chunk < 10; chunk++) {
          stagedDone = (await stageNextChunk({ store: durable, plan: exchangePlan, oldModels,
            desiredModels: desired, mappers, chunkSize: 1 })).done;
        }
        assert.equal(stagedDone, true, 'bounded staging finishes without omitting rows');
        await validateStaged({ store: durable, plan: exchangePlan, oldModels,
          desiredModels: desired, oldLocks: new Map() });
        const inspect = async (storage: StoragePort) => ({
          models: await Promise.all([...oldModels.keys()].map(async model => {
            const rows = [...await storage.query({ model, authority: 'owner', archived: 'include' })]
              .sort((a, b) => String(a.id).localeCompare(String(b.id)));
            return { model, rows, history: await Promise.all(rows.map(row => storage.historyFor(model, row.id))) };
          })),
          claims: await Promise.all(['É', 'é', 'unchanged'].map(key => storage.uniqueOwner!(tag, givenUniqueKeyName(oldRule.rule), key))),
          installed: await storage.readInstalledSnapshot(predecessorSnapshot.owner), outbox: await storage.outboxPending(),
        });
        const original = await inspect(durable);
        assert.ok(original.claims.every(owner => owner !== null));
        assert.notEqual(original.claims[0], original.claims[1]);
        if (modeIndex === 0 || mode.adapter === 'do') {
          const protectedRevision = await durable.readRevision();
          const protectedProgress = await durable.readMigrationProgress(exchangePlan.migrationId);
          assert.ok(protectedProgress);
          await assert.rejects(durable.publishMigrationChunk({ expectedRevision: protectedRevision,
            migrationId: exchangePlan.migrationId, rows: [], history: [], drops: [], progress: protectedProgress,
            uniqueReleases: [{ model: tag, keyName: givenUniqueKeyName(oldRule.rule), keyValue: 'É', recordId: original.claims[1]! }],
          }), /owner differs or is missing/, "migration cannot release another record owner's claim");
          assert.equal(await durable.readRevision(), protectedRevision);
          assert.deepEqual(await durable.readMigrationProgress(exchangePlan.migrationId), protectedProgress);
          assert.deepEqual(await inspect(durable), original, 'foreign release refusal changes nothing');
        }
        let failed = false;
        const seen = new Set<MigrationPhase>();
        const fault: { progress: Awaited<ReturnType<typeof durable.readMigrationProgress>> } = { progress: null };
        let stateAtFailure: Awaited<ReturnType<typeof inspect>> | undefined;
        const observed = new Proxy(durable, { get(target, property) {
          if (property === 'publishMigrationChunk') return async (chunk: PublishMigrationChunk) => {
            seen.add(chunk.progress.phase);
            if (!mode.staged) {
              assert.equal(chunk.rows.length, 0, 'pure retains never republish rows');
              assert.equal(chunk.history.length, 0);
            }
            assert.ok(chunk.rows.length <= 1 && chunk.history.length <= 1, 'one mapped row per publish chunk');
            assert.equal(chunk.drops.length, 0);
            assert.ok((chunk.uniqueClaims?.length ?? 0) <= 1, 'one row per bounded claim chunk');
            const movement = mode.phase === 'releasing-claims' ? (chunk.uniqueReleases?.length ?? 0) > 0
              : mode.phase === 'retaining-claims' ? (chunk.uniqueClaims?.length ?? 0) > 0
              : !mode.staged || chunk.rows.length > 0;
            const inject = !failed && mode.phase === chunk.progress.phase && movement;
            if (inject && mode.acknowledgement === 'before') {
              failed = true;
              fault.progress = await target.readMigrationProgress(exchangePlan.migrationId);
              stateAtFailure = await inspect(target);
              throw new Error(`before ${mode.phase} commit`);
            }
            const result = await target.publishMigrationChunk(chunk);
            const current = await target.readMigrationProgress(exchangePlan.migrationId);
            assert.equal(current?.phase, chunk.progress.phase);
            assert.deepEqual(current?.publishCursor, chunk.progress.publishCursor, 'cursor commits with the actual claim batch');
            assert.equal(await target.uniqueOwner!(tag, givenUniqueKeyName(oldRule.rule), 'unchanged'), original.claims[2],
              'a key unaffected by the compiled rule change must never lose its claim');
            if (inject && mode.acknowledgement === 'after') {
              failed = true;
              fault.progress = current; stateAtFailure = await inspect(target);
              throw new Error(`lost ${mode.phase} acknowledgement`);
            }
            return result;
          };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        const activation = { store: observed, plan: exchangePlan, oldModels, desiredModels: desired,
          inventory: [], chunkSize: 1, clock: { nowMs: () => FIXED_NOW } };
        if (mode.phase === null) {
          assert.equal((await activate(activation)).flipped, true);
          for (const phase of phases) assert.ok(seen.has(phase), `${phase} has a real persisted batch`);
        } else {
          await assert.rejects(activate(activation), /(?:before|lost) .*(?:commit|acknowledgement)/);
          assert.equal(failed, true, 'the selected actual durable phase was reached');
          const failure = await durable.readMigrationFailure(exchangePlan.migrationId);
          assert.equal((await durable.readMigrationProgress(exchangePlan.migrationId))?.phase, 'failed');
          assert.equal(failure?.priorPhase, fault.progress?.phase);
          assert.deepEqual(failure?.publishCursor, fault.progress?.publishCursor,
            'recovery observes either the unchanged precommit cursor or the committed lost-ack cursor');
          assert.deepEqual(await inspect(durable), stateAtFailure, 'failure bookkeeping cannot change rows, history, claims or pointer');
          await assert.rejects(abortMigration(durable, exchangePlan.migrationId), /(?:forward-only|activation|publish)/,
            'an activation failure never authorizes destructive rollback');
        }
        await runtime.dispose(); runtime = start(); durable = await open();
        if (mode.phase !== null) {
          assert.deepEqual(await inspect(durable), stateAtFailure, 'a new workerd instance reads the committed failure state');
          assert.equal((await resumeMigration({ ...activation, store: durable,
            mappers, oldLocks: new Map(), failedDecision: { decision: 'retry' } })).flip?.flipped, true);
        }
        const completed = await inspect(durable);
        if (!mode.staged) {
          assert.deepEqual(completed.models, original.models, 'pure retain preserves every live row and history entry');
        } else {
          for (const before of original.models) {
            const after = completed.models.find(model => model.model === before.model)!;
            if (before.model !== tag) { assert.deepEqual(after, before); continue; }
            for (const [index, row] of before.rows.entries()) {
              const updated = after.rows.find(candidate => candidate.id === row.id)!;
              const name = row.data.name === 'É' ? 'é' : row.data.name === 'é' ? 'É' : row.data.name;
              assert.deepEqual(updated.data, { ...row.data, name });
              assert.equal(updated.version, Number(row.version) + 1);
              assert.equal(updated.created, row.created); assert.equal(updated.createdBy, row.createdBy);
              assert.equal(updated.archivedAt, row.archivedAt);
              const history = after.history[after.rows.indexOf(updated)]!;
              assert.deepEqual(history.slice(0, before.history[index]!.length), before.history[index]);
              assert.equal(history.length, before.history[index]!.length + 1, 'one history entry despite lost acknowledgement');
              assert.equal(history.at(-1)?.actor, `migration:${exchangePlan.toSnapshotId}`);
            }
          }
        }
        assert.deepEqual(completed.outbox, original.outbox);
        assert.deepEqual(completed.claims, [original.claims[1], original.claims[0], original.claims[2]],
          'actual compiled computed-key ownership exchanges across chunkSize 1 and retains unchanged keys');
        assert.equal(completed.installed?.snapshotId, exchangePlan.toSnapshotId);
        assert.equal(completed.installed?.digest, exchangePlan.toDigest);
        assert.equal((await durable.readMigrationProgress(exchangePlan.migrationId))?.phase, 'active');
        assert.equal((await resumeMigration({ ...activation, store: durable, mappers, oldLocks: new Map() })).flip, null,
          'reopening completed activation does not replay claims or the snapshot flip');
      } finally { await runtime.dispose(); }
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
