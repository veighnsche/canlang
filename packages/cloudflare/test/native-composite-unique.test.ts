/** Original source attachment to State's existing tuple implementation. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const fixture = fileURLToPath(new URL('./fixtures/native-ref-enum-unique.can', import.meta.url));
const APP = 'NativeCompositeUnique', BRANCH = `${APP}.Branch` as ModelName;
const RUN = `${APP}.Run` as ModelName, TURN = `${APP}.Turn` as ModelName;
const require = createRequire(import.meta.url);
const stdlibUrl = pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const uiUrl = pathToFileURL(require.resolve('@canlang/ui')).href;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const conflict = (error: unknown) => typeof error === 'object' && error !== null &&
  ('code' in error && error.code === 'conflict' || 'kind' in error && error.kind === 'unique');

test('original required Run/owning enum tuple joins State without changing canonical scalar keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-native-composite-unique-'));
  const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
  const paths = [fixture, compiler, catalog], before = await Promise.all(paths.map(async path => hash(await readFile(path))));
  try {
    const source = await readFile(fixture, 'utf8');
    const compile = async (path: string): Promise<CompileArtifact> => {
      const env = {...process.env}; delete env.CAN_CATALOG;
      const {stdout} = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, path],
        {cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024});
      const artifact = JSON.parse(stdout) as CompileArtifact;
      assert.ok(artifact.sources.some(item => resolve(item.path) === path));
      return artifact;
    };
    const assemble = (artifact: CompileArtifact, path: string, label: string) =>
      assembleModules({artifact, sourcePath: path}, {workDir: join(dir, label), stdlibUrl, uiUrl});
    const artifact = await compile(fixture), artifactBefore = JSON.stringify(artifact);
    assert.ok(artifact.sources.some(item => resolve(item.path) === fixture && item.sha256 === before[0]));
    const asm = await assemble(artifact, fixture, 'original');
    const namespace = await importVerifiedAssemblyModule(asm, artifact.modules[0]!.path, artifact) as {
      appDefinition: {modelRuleOrigins?: Array<{ordinal: number; kind: string; model: string; ownerPackage: string;
        source: {path: string; sha256: string; module: string}; registryId?: string}>;
        models: Record<string, {uniques?: Array<{fields: string[]}>; fields: Record<string, unknown>}>};
    };
    const origins = namespace.appDefinition.modelRuleOrigins;
    // Optional producer facts describe this fixture; they confer no extra
    // unconditional tuple authority and may be absent in a verified cohort.
    if (origins !== undefined) {
      assert.deepEqual(origins.map(origin => origin.ordinal), [0, 1, 2, 3, 4]);
      assert.deepEqual(origins.map(origin => origin.kind), ['policy', 'policy', 'policy', 'unique', 'unique']);
      assert.deepEqual(origins.filter(origin => origin.kind === 'unique').map(origin => origin.model), [TURN, TURN]);
      for (const origin of origins) {
        assert.equal(origin.ownerPackage, APP); assert.equal(origin.source.module, APP);
        assert.equal(resolve(origin.source.path), fixture); assert.equal(origin.source.sha256, before[0]);
      }
      assert.equal(Object.hasOwn(origins[4]!, 'registryId'), false);
    }
    assert.deepEqual(namespace.appDefinition.models[TURN]!.uniques, [{fields: ['position']}, {fields: ['run', 'role']}]);
    const originalTurn = artifact.models!.find(model => model.name === TURN)!;
    assert.deepEqual(originalTurn.fields.find(field => field.name === 'run')!.field, {kind: 'ref', model: RUN});
    assert.deepEqual(originalTurn.fields.find(field => field.name === 'role')!.field,
      {kind: 'enum', values: ['system', 'user', 'assistant']});
    for (const name of ['run', 'role']) assert.equal(originalTurn.fields.find(field => field.name === name)!.required, true);
    const loaded = await loadCanonicalDescriptors(asm, artifact), table = loaded.table as ModelTable;
    assert.deepEqual(table.get(TURN)?.uniqueGroups, [['run', 'role']]);
    assert.deepEqual(table.get(TURN)?.uniqueKeys, ['position', 'run,role']);
    assert.deepEqual(loaded.models.find(model => model.name === TURN)?.uniqueKeys, ['position']);
    assert.equal(JSON.stringify(artifact), artifactBefore);
    const withoutOrigins = {...artifact, modules: artifact.modules.map((module, index) => index === 0
      ? {...module, js: `${module.js}\ndelete appDefinition.modelRuleOrigins;\n`} : module)};
    const withoutOriginsBefore = JSON.stringify(withoutOrigins);
    const withoutOriginsAsm = await assemble(withoutOrigins, fixture, 'without-optional-origins');
    const withoutOriginsLoaded = await loadCanonicalDescriptors(withoutOriginsAsm, withoutOrigins);
    assert.deepEqual((withoutOriginsLoaded.table as ModelTable).get(TURN)?.uniqueGroups, [['run', 'role']]);
    assert.deepEqual(withoutOriginsLoaded.models.find(model => model.name === TURN)?.uniqueKeys, ['position']);
    assert.equal(JSON.stringify(withoutOrigins), withoutOriginsBefore);

    // Exercise only the new source attachment. State's accepted tuple controls
    // own replay, separate owner stores, archive/recovery and durable parity.
    const {store} = createTestMemoryStorage();
    const context = (id: string): InvocationContext => ({kind: 'user', app: APP, actor: {userId: 'member'},
      team: {teamId: 'tuple-owner', timezone: 'UTC'}, operation: `${APP}.Turn.create` as OperationName,
      operationId: `tuple-${id}` as OperationId, source: 'test', now: 1000});
    const create = async (model: ModelName, id: string, data: Record<string, unknown>) => {
      const expectedRevision = await store.readRevision();
      const effects = await runMutationWrites({table, store, context: context(id), writes: [
        {op: 'create', model, id: id as RecordId, data,
          ...(model === BRANCH ? {} : {parent: {model: BRANCH, id: 'branch' as RecordId}})}]});
      await store.commit({expectedRevision, writes: effects.writes, history: effects.history,
        receipt: null, outbox: [], schedules: effects.schedules,
        uniqueClaims: effects.uniqueClaims, uniqueReleases: effects.uniqueReleases});
    };
    await create(BRANCH, 'branch', {title: 'Owner branch'});
    await create(RUN, 'r1', {title: 'First run'}); await create(RUN, 'r2', {title: 'Second run'});
    await create(TURN, 'first', {run: {id: 'r1'}, role: 'user', position: '1'});
    const revision = await store.readRevision(), rows = await store.query({model: TURN, authority: 'owner'});
    const history = await store.historyFor(TURN, 'first' as RecordId);
    await assert.rejects(create(TURN, 'duplicate', {run: {id: 'r1'}, role: 'user', position: '2'}), conflict);
    assert.equal(await store.readRevision(), revision); assert.deepEqual(await store.query({model: TURN, authority: 'owner'}), rows);
    assert.deepEqual(await store.historyFor(TURN, 'first' as RecordId), history);
    assert.equal(await store.load(TURN, 'duplicate' as RecordId), null);
    assert.deepEqual(await store.historyFor(TURN, 'duplicate' as RecordId), []);
    await create(TURN, 'other-role', {run: {id: 'r1'}, role: 'assistant', position: '2'});
    await create(TURN, 'other-run', {run: {id: 'r2'}, role: 'user', position: '3'});
    await assert.rejects(create(TURN, 'same-position', {run: {id: 'r2'}, role: 'assistant', position: '3'}), conflict);

    // Distinct association risks use the real emitted definition, retaining
    // unchanged owning fields and source inputs rather than engine mocks.
    const turnDeclaration = `appDefinition.models[${JSON.stringify(TURN)}]`;
    const tupleFields = `${turnDeclaration}.uniques[1].fields`;
    const mutations = [
      ['wrong-model', `appDefinition.models[${JSON.stringify(RUN)}].uniques=[${turnDeclaration}.uniques[1]]; delete ${turnDeclaration}.uniques;`],
      ['wrong-field', `${tupleFields}[0]="missing";`],
      ['wrong-ref-target', `${turnDeclaration}.fields.run.type=${JSON.stringify(BRANCH)};`],
      ['wrong-enum-source', `${turnDeclaration}.fields.role.cases=["user","assistant"];`],
      ['accessor-fields', `export let uniqueFieldReads=0; Object.defineProperty(${tupleFields},"0",{enumerable:true,get(){uniqueFieldReads++;return "run";}});`],
      ['hole-fields', `delete ${tupleFields}[0];`],
      ['extra-fields', `${tupleFields}.extra="unowned";`],
    ] as const;
    for (const [label, mutation] of mutations) {
      const mutant = {...artifact, modules: artifact.modules.map((module, index) => index === 0
        ? {...module, js: `${module.js}\n${mutation}\n`} : module)};
      const mutantBefore = JSON.stringify(mutant), mutantAsm = await assemble(mutant, fixture, label);
      await assert.rejects(loadCanonicalDescriptors(mutantAsm, mutant), /uniqu|origin|association|source/i, label);
      assert.equal(JSON.stringify(mutant), mutantBefore);
      if (label === 'accessor-fields') {
        const evaluated = await importVerifiedAssemblyModule(mutantAsm, mutant.modules[0]!.path, mutant) as {uniqueFieldReads: number};
        assert.equal(evaluated.uniqueFieldReads, 0, 'malformed tuple descriptors refuse before invoking their getters');
      }
    }
    const optionalRef = {...artifact, models: artifact.models!.map(model => model.name === TURN
      ? {...model, fields: model.fields.map(field => field.name === 'run' ? {...field, required: false} : field)} : model)};
    const optionalRefBefore = JSON.stringify(optionalRef), optionalRefAsm = await assemble(optionalRef, fixture, 'optional-ref-association');
    await assert.rejects(loadCanonicalDescriptors(optionalRefAsm, optionalRef), /uniqu|association|composite|tuple/i);
    assert.equal(JSON.stringify(optionalRef), optionalRefBefore);
    const variants = [
      ['reversed', source.replace('unique Turn fields=run,role', 'unique Turn fields=role,run')],
      ['duplicate-fields', source.replace('unique Turn fields=run,role', 'unique Turn fields=run,run')],
      ['nullable', source.replace('run:Run,', 'run:Run?,')],
      ['array', source.replace('role:TextMessage.role,', 'role:TextMessage.role[],')],
      ['secret', source.replace('role:TextMessage.role,', 'role:secret server=random_secret(),')
        .replace('fields=run,role,position', 'fields=run,position')],
      ['file', source.replace('role:TextMessage.role,', 'role:file,')],
      ['conditional', source.replace('position:int}', 'position:int,active:bool=true}')
        .replace('unique Turn fields=run,role', 'unique Turn fields=run,role where=row.active')],
    ] as const;
    for (const [label, text] of variants) {
      assert.notEqual(text, source);
      const path = join(dir, `${label}.can`); await writeFile(path, text);
      const candidate = await compile(path), candidateBefore = JSON.stringify(candidate);
      const candidateAsm = await assemble(candidate, path, `${label}-modules`);
      await assert.rejects(loadCanonicalDescriptors(candidateAsm, candidate), /uniqu|association|composite|tuple/i, label);
      assert.equal(JSON.stringify(candidate), candidateBefore); assert.equal(await readFile(path, 'utf8'), text);
    }
    assert.equal(JSON.stringify(artifact), artifactBefore);
    assert.deepEqual(await Promise.all(paths.map(async path => hash(await readFile(path)))), before,
      'original source, compiler and catalog remain current');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('original User/inline-enum unique joins its sparse source fields and refuses altered owning associations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-native-user-enum-unique-'));
  const source = `app NativeUserUnique
Given
 Customer {title:text}
 CompanyRole in Customer {account:user,role:enum(administrator,booker,billing)}
 policy Customer read=members
 policy CompanyRole read=members
 unique CompanyRole fields=account,role
When
Then
`;
  const path = join(dir, 'UserUnique.can');
  const roleModel = 'NativeUserUnique.CompanyRole' as ModelName;
  try {
    await writeFile(path, source);
    const env = {...process.env}; delete env.CAN_CATALOG;
    const {stdout} = await promisify(execFile)(join(root, 'compiler/target/debug/can'),
      ['compile', '--format=json', '--catalog', fileURLToPath(distribution.catalog), path],
      {cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024});
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const original = JSON.stringify(artifact);
    const fields = artifact.models!.find(model => model.name === roleModel)!.fields;
    assert.deepEqual(fields.map(field => [field.name, field.field, field.valueType]), [
      ['account', {kind: 'user'}, undefined],
      ['role', {kind: 'enum', values: ['administrator', 'booker', 'billing']}, undefined],
    ]);
    const assemble = (candidate: CompileArtifact, label: string) => assembleModules(
      {artifact: candidate, sourcePath: path}, {workDir: join(dir, label), stdlibUrl, uiUrl});
    const loaded = await loadCanonicalDescriptors(await assemble(artifact, 'original'), artifact);
    const definition = (loaded.table as ModelTable).get(roleModel)!;
    assert.deepEqual(definition.uniqueGroups, [['account', 'role']]);
    assert.equal(definition.fields.account!.valueType, 'user');
    assert.equal(definition.fields.role!.valueType, 'enum(administrator,booker,billing)');
    assert.deepEqual(definition.refs, []);
    assert.equal(definition.containment?.parent, 'NativeUserUnique.Customer');
    const declaration = `appDefinition.models[${JSON.stringify(roleModel)}]`;
    for (const [label, mutation] of [
      ['order', `${declaration}.uniques[0].fields=["role","account"];`],
      ['wrong-identity-type', `${declaration}.fields.account.type="text";`],
      ['wrong-cases', `${declaration}.fields.role.cases=["administrator","booker"];`],
      ['duplicate', `${declaration}.uniques.push(${declaration}.uniques[0]);`],
    ] as const) {
      const candidate = {...artifact, modules: artifact.modules.map((module, index) => index === 0
        ? {...module, js: `${module.js}\n${mutation}\n`} : module)};
      await assert.rejects(loadCanonicalDescriptors(await assemble(candidate, label), candidate),
        /uniqu|association|source|type/i, label);
    }
    for (const [label, patch] of [
      ['optional-user', {required: false}], ['nullable-user', {nullable: true}],
      ['array-user', {array: {required: true}}],
    ] as const) {
      const candidate = {...artifact, models: artifact.models!.map(model => model.name === roleModel
        ? {...model, fields: model.fields.map(field => field.name === 'account' ? {...field, ...patch} : field)} : model)};
      await assert.rejects(loadCanonicalDescriptors(await assemble(candidate, label), candidate),
        /uniqu|association|source|type|composite/i, label);
    }
    assert.equal(JSON.stringify(artifact), original);
    assert.equal(await readFile(path, 'utf8'), source);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
