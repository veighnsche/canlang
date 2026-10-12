/** Real compiled model-level unique declarations join the owning State table. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CompileArtifact, InvocationContext, ModelName, OperationId, OperationName, RecordId } from '@canlang/contracts';
import type { ModelTable } from '@canlang/state/mutation';
import { runMutationWrites } from '@canlang/state/mutation';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { distribution } from '@canlang/values/distribution';
import { assembleModules, importVerifiedAssemblyModule } from '@canlang/cloudflare/runtime/modules';
import { loadCanonicalDescriptors } from '@canlang/cloudflare/runtime/invoke';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const fixture = fileURLToPath(new URL('./fixtures/conditional-unique.can', import.meta.url));
const officeFixture = fileURLToPath(new URL('./fixtures/conditional-unique-office.can', import.meta.url));
const originalOfficeFixture = fileURLToPath(new URL('./fixtures/conditional-unique-original-office.can', import.meta.url));
const require = createRequire(import.meta.url);
const stdlibUrl = pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const uiUrl = pathToFileURL(require.resolve('@canlang/ui')).href;

test('original conditional unique joins State and unsupported profiles refuse activation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-conditional-unique-refusal-'));
  try {
    const source = await readFile(fixture, 'utf8');
    const control = join(dir, 'unconditional-control.can');
    assert.equal(source.split('unique Item fields=code where=row.active').length, 2);
    await writeFile(control, source.replace('unique Item fields=code where=row.active', 'unique Item fields=code'));
    const compiler = join(root, 'compiler/target/debug/can');
    const catalog = fileURLToPath(distribution.catalog);
    const compile = async (path: string): Promise<CompileArtifact> => {
      const env = { ...process.env }; delete env.CAN_CATALOG;
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, path],
        { cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      return JSON.parse(stdout) as CompileArtifact;
    };
    const conditional = await compile(fixture);
    assert.equal(conditional.modelPolicies, undefined);
    assert.equal(conditional.models?.[0]?.uniqueKeys, undefined,
      'the unjoined conditional key cannot masquerade as an unconditional artifact key');
    assert.match(conditional.modules[0]!.js, /wherePredicate:/);
    const wrongRegistryJs = conditional.modules[0]!.js.replace('where:"Item.unique.1"',
      'where:"WrongModel.unique.1"');
    assert.notEqual(wrongRegistryJs, conditional.modules[0]!.js);
    const wrongRegistry = {...conditional, modules: conditional.modules.map((module, index) =>
      index === 0 ? {...module, js: wrongRegistryJs} : module)};
    const wrongRegistryAssembly = await assembleModules({artifact: wrongRegistry, sourcePath: fixture},
      {workDir: join(dir, 'wrong-registry-modules'), stdlibUrl, uiUrl});
    await assert.rejects(loadCanonicalDescriptors(wrongRegistryAssembly, wrongRegistry),
      /conditional unique lacks its exact source, owner, registry or ordinal/i,
      'a suffix-matching registry for another model cannot activate this unique key');
    const claimed = await assembleModules({ artifact: conditional, sourcePath: fixture },
      { workDir: join(dir, 'conditional-modules'), stdlibUrl, uiUrl });
    const installed = await loadCanonicalDescriptors(claimed, conditional);
    const conditionalTable = installed.table as ModelTable;
    assert.deepEqual(conditionalTable.get('ConditionalRefusal.Item' as ModelName)?.uniqueKeys, ['code']);
    assert.deepEqual(conditionalTable.get('ConditionalRefusal.Item' as ModelName)?.uniqueWhen?.code,
      {op: 'eq', field: 'active', value: true});
    assert.equal(installed.models[0]?.uniqueKeys, undefined,
      'a conditional source key must not turn into an unconditional canonical key');

    const unsupportedSource = join(dir, 'unsupported-predicate.can');
    await writeFile(unsupportedSource, source.replace('where=row.active', 'where=row.code=="reserved"'));
    const unsupported = await compile(unsupportedSource);
    const unsupportedAssembly = await assembleModules({ artifact: unsupported, sourcePath: unsupportedSource },
      { workDir: join(dir, 'unsupported-modules'), stdlibUrl, uiUrl });
    await assert.rejects(loadCanonicalDescriptors(unsupportedAssembly, unsupported), /conditional unique|declared stored bool/i);

    const plain = await compile(control);
    assert.match(plain.modules[0]!.js, /uniques:\[\{fields:\["code"\]\}\]/,
      'the control retains its original unconditional declaration');
    const safe = await assembleModules({ artifact: plain, sourcePath: control },
      { workDir: join(dir, 'unconditional-modules'), stdlibUrl, uiUrl });
    const loaded = await loadCanonicalDescriptors(safe, plain);
    assert.equal(loaded.models[0]?.name, 'ConditionalRefusal.Item',
      'this refusal does not block an ordinary unique declaration');
    assert.deepEqual(loaded.models[0]?.uniqueKeys, ['code'],
      'the original singular declaration reaches the State model table');

    const fileSource = join(dir, 'unsupported-file-key.can');
    await writeFile(fileSource, source.replace('code:text', 'graph:file')
      .replace('unique Item fields=code where=row.active', 'unique Item fields=graph')
      .replace('fields=code,active', 'fields=graph,active'));
    const fileKey = await compile(fileSource);
    const fileAssembly = await assembleModules({artifact: fileKey, sourcePath: fileSource},
      {workDir: join(dir, 'file-key-modules'), stdlibUrl, uiUrl});
    await assert.rejects(loadCanonicalDescriptors(fileAssembly, fileKey), /unique field.*association/i,
      'a genuine File declaration cannot become a scalar State uniqueness claim');

    const office = await compile(officeFixture);
    assert.match(office.modules[0]!.js, /ordinal:1/);
    assert.match(office.modules[0]!.js, /"kind":"invariant"[^}]*"ordinal":2/);
    const wrongOrdinalJs = office.modules[0]!.js.replace('ordinal:1', 'ordinal:2');
    assert.notEqual(wrongOrdinalJs, office.modules[0]!.js);
    const wrongOrdinal = {...office, modules: office.modules.map((module, index) =>
      index === 0 ? {...module, js: wrongOrdinalJs} : module)};
    const wrongOrdinalAssembly = await assembleModules({artifact: wrongOrdinal, sourcePath: officeFixture},
      {workDir: join(dir, 'wrong-ordinal-modules'), stdlibUrl, uiUrl});
    await assert.rejects(loadCanonicalDescriptors(wrongOrdinalAssembly, wrongOrdinal),
      /conditional unique lacks its original global rule origin/i,
      'a positive ordinal naming another original rule cannot activate a unique predicate');
    const officeAssembly = await assembleModules({artifact: office, sourcePath: officeFixture},
      {workDir: join(dir, 'office-modules'), stdlibUrl, uiUrl});
    const officeLoaded = await loadCanonicalDescriptors(officeAssembly, office);
    const officeModel = 'ConditionalOffice.Item' as ModelName;
    const table = officeLoaded.table as ModelTable;
    assert.deepEqual(table.get(officeModel)?.uniqueWhen?.qty, {op: 'eq', field: 'closed', value: true});
    const {store} = createTestMemoryStorage();
    const commit = async (id: string, closed: boolean) => {
      const expectedRevision = await store.readRevision();
      const context: InvocationContext = {kind: 'user', app: 'ConditionalOffice', actor: {userId: 'member'},
        team: {teamId: 'office', timezone: 'UTC'}, operation: 'ConditionalOffice.Item.create' as OperationName,
        operationId: `office-${id}` as OperationId, source: 'test', now: 1000};
      const effects = await runMutationWrites({table, store, context,
        writes: [{op: 'create', model: officeModel, id: id as RecordId, data: {qty: '7', title: id, closed}}]});
      await store.commit({expectedRevision, writes: effects.writes, history: effects.history,
        receipt: null, outbox: [], schedules: effects.schedules,
        uniqueClaims: effects.uniqueClaims, uniqueReleases: effects.uniqueReleases});
    };
    await commit('inactive-a', false);
    await commit('inactive-b', false);
    await commit('active-a', true);
    const beforeConflict = await store.readRevision();
    await assert.rejects(commit('active-b', true), error => typeof error === 'object' && error !== null &&
      ('code' in error && error.code === 'conflict' || 'kind' in error && error.kind === 'unique'));
    assert.equal(await store.readRevision(), beforeConflict);
    assert.equal(await store.load(officeModel, 'active-b' as RecordId), null);
    assert.equal((await store.load(officeModel, 'inactive-a' as RecordId))?.data.closed, false);
    assert.equal((await store.load(officeModel, 'inactive-b' as RecordId))?.data.closed, false);

    const originalOffice = await compile(originalOfficeFixture);
    assert.match(originalOffice.modules[0]!.js, /ordinal:5/);
    const originalAssembly = await assembleModules({artifact: originalOffice, sourcePath: originalOfficeFixture},
      {workDir: join(dir, 'original-office-modules'), stdlibUrl, uiUrl});
    const originalEntry = await importVerifiedAssemblyModule(originalAssembly, originalOffice.modules[0]!.path, originalOffice) as {
      appDefinition: {modelRuleOrigins: Array<{ordinal: number; kind: string; model: string; registryId?: string}>};
    };
    assert.equal(originalEntry.appDefinition.modelRuleOrigins.length, 11);
    assert.deepEqual(originalEntry.appDefinition.modelRuleOrigins[5] && {
      ordinal: originalEntry.appDefinition.modelRuleOrigins[5].ordinal,
      kind: originalEntry.appDefinition.modelRuleOrigins[5].kind,
      model: originalEntry.appDefinition.modelRuleOrigins[5].model,
      registryId: originalEntry.appDefinition.modelRuleOrigins[5].registryId,
    }, {ordinal: 5, kind: 'unique', model: 'Office.Item', registryId: 'Office.Item.unique.1'});
    const originalLoaded = await loadCanonicalDescriptors(originalAssembly, originalOffice);
    const originalModel = 'Office.Item' as ModelName;
    const originalTable = originalLoaded.table as ModelTable;
    assert.deepEqual(originalTable.get(originalModel)?.uniqueWhen?.qty, {op: 'eq', field: 'closed', value: true});
    const {store: originalStore} = createTestMemoryStorage();
    const commitOriginal = async (id: string, closed: boolean) => {
      const expectedRevision = await originalStore.readRevision();
      const context: InvocationContext = {kind: 'user', app: 'Office', actor: {userId: 'member'},
        team: {teamId: 'office-original', timezone: 'UTC'}, operation: 'Office.Item.create' as OperationName,
        operationId: `original-${id}` as OperationId, source: 'test', now: 1000};
      const effects = await runMutationWrites({table: originalTable, store: originalStore, context,
        writes: [{op: 'create', model: originalModel, id: id as RecordId, data: {qty: '7', title: id, closed}}]});
      await originalStore.commit({expectedRevision, writes: effects.writes, history: effects.history,
        receipt: null, outbox: [], schedules: effects.schedules,
        uniqueClaims: effects.uniqueClaims, uniqueReleases: effects.uniqueReleases});
    };
    await commitOriginal('inactive-a', false);
    await commitOriginal('inactive-b', false);
    await commitOriginal('active-a', true);
    const beforeOriginalConflict = await originalStore.readRevision();
    await assert.rejects(commitOriginal('active-b', true), error => typeof error === 'object' && error !== null &&
      ('code' in error && error.code === 'conflict' || 'kind' in error && error.kind === 'unique'));
    assert.equal(await originalStore.readRevision(), beforeOriginalConflict);
    assert.equal(await originalStore.load(originalModel, 'active-b' as RecordId), null);
    assert.equal((await originalStore.load(originalModel, 'inactive-a' as RecordId))?.data.closed, false);
    assert.equal((await originalStore.load(originalModel, 'inactive-b' as RecordId))?.data.closed, false);

  } finally { await rm(dir, { recursive: true, force: true }); }
});
