/** Composed source package facades are verified without inventing writer declarations. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CanonicalOperationDescriptor, CompileArtifact, MutationEnvelope } from '@canlang/contracts';
import { distribution } from '@canlang/values/distribution';
import { ensureSchema } from '@canlang/state/storage/d1';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work';
import { asModel, asOperation, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity } from '@canlang/identity';
import { createSqliteFileStore, type SqliteFileStore } from '@canlang/files/host/sqlite';
import { assembleModules, importVerifiedAssemblyModule } from '@canlang/cloudflare/runtime/modules';
import { loadCanonicalDescriptors } from '@canlang/cloudflare/runtime/invoke';
import { buildInvoker } from '@canlang/cloudflare/worker/assembly';
import { createNativeFileRetirementBinding } from '../dist/runtime/file-retirement.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const fixture = fileURLToPath(new URL('./fixtures/native-composed-file-retirement.can', import.meta.url));
const APP = 'NativeComposedFiles', PACKAGE = 'entries', MODEL = asModel('entries.Entry');
const NOW = Date.UTC(2026, 9, 12, 14);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function snapshot(db: D1Database) {
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name: string}>();
  assert.equal(tables.success, true);
  const result: Record<string, readonly Record<string, unknown>[]> = {};
  for (const {name} of tables.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true); result[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}

test('composed native File inventory verifies constant-only facade and captures every actual entry callable',
  {timeout: 120000}, async () => {
    const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
    const paths = [fixture, compiler, catalog], originals = await Promise.all(paths.map(async path => hash(await readFile(path))));
    const dir = await mkdtemp(join(tmpdir(), 'can-native-composed-file-'));
    let worker: Miniflare | undefined, physical: SqliteFileStore | undefined, sequence = 0;
    const clock = {nowMs: () => NOW}, nextId = () => asOperationId(uuidv7(NOW, ++sequence));
    try {
      const env = {...process.env}; delete env.CAN_CATALOG;
      const {stdout} = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, fixture],
        {cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024});
      const artifact = JSON.parse(stdout) as CompileArtifact, originalArtifact = JSON.stringify(artifact);
      assert.ok(artifact.sources.some(source => resolve(source.path) === fixture && source.sha256 === originals[0]));
      assert.equal(artifact.modules.length, 2);
      const entry = artifact.modules[0]!, facade = artifact.modules[1]!;
      const actual = artifact.callables.filter(callable => callable.kind === 'operation' || callable.kind === 'handler');
      assert.deepEqual(actual.map(callable => callable.id).sort(),
        ['entries.Entry.create', 'entries.Entry.update', 'entries.Entry.delete', 'entries.attach'].sort());
      assert.ok(actual.every(callable => callable.module === entry.path));
      assert.equal(actual.filter(callable => callable.module === facade.path).length, 0);
      const assemble = (candidate: CompileArtifact, label: string) => assembleModules({artifact: candidate, sourcePath: fixture},
        {workDir: join(dir, label), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
          uiUrl: import.meta.resolve('@canlang/ui')});
      const asm = await assemble(artifact, 'original');
      const facadeNamespace = await importVerifiedAssemblyModule(asm, facade.path, artifact);
      assert.equal(Object.hasOwn(facadeNamespace as object, 'appDefinition'), false);

      worker = new Miniflare({compatibilityDate: '2026-07-15', modules: true,
        script: 'export default {fetch(){return new Response("ok")}}', d1Persist: join(dir, 'd1'),
        d1Databases: {IDENTITY: 'composed-file-identity', OWNER: 'composed-file-owner'}});
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const db = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(db);
      const identities = createD1IdentityStore(identityDb, {clock}), team = await identities.createTeam({timezone: 'UTC'});
      const user = await identities.createUser({email: 'composed-file@example.test', password_hash: 'unused', email_verified: true});
      await identities.createMembership({team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: []});
      const grant = await issueMcpGrant(identities,
        {team_id: team.team_id, user_id: user.user_id, client_id: 'native-composed-file'}, {clock});
      const identity = await resolveIdentity(identities, {mcp_grant_token: grant.token}, {clock});
      physical = createSqliteFileStore(join(dir, 'files.sqlite'));
      const input = {artifact, asm, scope: {app: APP, ownerPackage: PACKAGE, owner: team.team_id}, identities, db,
        stateStoreId: 'composed-file-owner', physicalSqliteFileStore: physical, initializeFresh: true as const, clock,
        intentTtlMs: 60000, urlBase: 'https://composed-file.invalid', maxRows: 100, maxReferences: 100,
        retention: {unattachedHorizonMs: 120000, retentionMs: 600000}};
      const resources = async () => ({owner: await snapshot(db), identity: await snapshot(identityDb),
        fileStoreId: physical!.fileStoreId, files: physical!.files.listAll(), intents: physical!.intents.listAll()});

      // A real writer reassigned to the facade still needs its own declaration.
      // Preserve its exported identity so absent metadata is the distinct gap.
      const writer = actual.find(callable => callable.id === 'entries.Entry.create')!;
      const reassigned = {...artifact, callables: artifact.callables.map(callable => callable === writer
        ? {...callable, module: facade.path} : callable), modules: artifact.modules.map(module => module === facade
        ? {...module, js: `${module.js}\nexport const ${writer.export}=${JSON.stringify(writer.id)};\n`} : module)};
      const reassignedBefore = JSON.stringify(reassigned), reassignedAsm = await assemble(reassigned, 'reassigned-writer');
      const beforeRefusal = await resources();
      await assert.rejects(createNativeFileRetirementBinding({...input, artifact: reassigned, asm: reassignedAsm}),
        /appDefinition|declaration|callable|module/i);
      assert.deepEqual(await resources(), beforeRefusal); assert.equal(JSON.stringify(reassigned), reassignedBefore);

      // Namespace exports are data properties; accessor metadata inside the
      // exported definition must also refuse without invoking the accessor.
      const accessor = {...artifact, modules: artifact.modules.map(module => module === facade ? {...module,
        js: `${module.js}\nexport let declarationReads=0;\nexport const appDefinition=Object.defineProperty({},"operations",{enumerable:true,get(){declarationReads++;return {};}});\n`} : module)};
      const accessorBefore = JSON.stringify(accessor), accessorAsm = await assemble(accessor, 'accessor-definition');
      await assert.rejects(createNativeFileRetirementBinding({...input, artifact: accessor, asm: accessorAsm}),
        /own.*data|declaration|metadata/i);
      const accessorNamespace = await importVerifiedAssemblyModule(accessorAsm, facade.path, accessor) as {declarationReads: number};
      assert.equal(accessorNamespace.declarationReads, 0); assert.deepEqual(await resources(), beforeRefusal);
      assert.equal(JSON.stringify(accessor), accessorBefore);

      const binding = await createNativeFileRetirementBinding(input);
      const installed = await binding.store.readFileReferenceInventory(PACKAGE); assert.ok(installed);
      assert.deepEqual(installed.inventory.frameworkModels,
        [...STATE_FILE_REFERENCE_PRODUCER.models, ...WORK_FILE_REFERENCE_PRODUCER.models]);
      assert.deepEqual(installed.inventory.artifactModels, artifact.models);
      assert.deepEqual(installed.inventory.valueTypes, artifact.valueTypes);
      assert.deepEqual(artifact.valueTypes?.contracts.map(contract => contract.name), ['entries.Metadata']);
      const sets = installed.inventory.opaqueDeclarationSets; assert.ok(sets); assert.equal(sets.length, 1);
      const originalSet = sets[0]!;
      assert.deepEqual(originalSet.sources, artifact.sources); assert.deepEqual(originalSet.artifactModels, artifact.models);
      assert.deepEqual(originalSet.valueTypes, artifact.valueTypes);
      assert.deepEqual(originalSet.originalContracts, {'entries.Metadata': {fields: {note: {type: 'text'}}}});
      assert.deepEqual(originalSet.declarations.map(declaration => declaration.id).sort(),
        ['entries.Entry.create:inputs', 'entries.Entry.update:inputs', 'entries.Entry.delete:inputs',
          'entries.attach:inputs', 'entries.attach:result'].sort());
      const loaded = await loadCanonicalDescriptors(asm, artifact);
      for (const declaration of originalSet.declarations) {
        assert.equal(declaration.source.kind, 'callable');
        if (declaration.source.kind !== 'callable') throw new Error('Actual callable source required.');
        const source = declaration.source;
        assert.equal(source.source.module, entry.path);
        assert.deepEqual(source.callable, actual.find(callable => callable.id === source.callable.id));
        assert.ok(artifact.sources.some(original => original.path === source.source.path && original.sha256 === source.source.sha256));
        const operation = artifact.operations!.find(operation => operation.name === source.callable.id)!;
        if (declaration.profile.kind === 'inputs') {
          assert.deepEqual(declaration.profile.artifact, operation.inputs.fields);
          const registered = loaded.registry.get(operation.name) as {descriptor: CanonicalOperationDescriptor};
          assert.deepEqual(declaration.profile.canonical, registered.descriptor.inputs);
        }
      }
      const attachment = artifact.models![0]!.fields.find(field => field.name === 'attachment')!;
      assert.equal(attachment.valueType, 'file?'); assert.equal(attachment.nullable, true);
      const attachInputs = originalSet.declarations.find(declaration => declaration.id === 'entries.attach:inputs')!;
      assert.equal(attachInputs.profile.kind, 'inputs');
      if (attachInputs.profile.kind !== 'inputs') throw new Error('Original attach inputs required.');
      assert.equal(attachInputs.profile.artifact.find(field => field.name === 'attachment')!.valueType, 'file');
      assert.equal(attachInputs.profile.artifact.find(field => field.name === 'attachment')!.required, true);

      const invoker = buildInvoker(artifact, asm, binding.store, {appId: APP, memberships: identities,
        source: 'http', now: clock.nowMs, ownerStorage: binding.ownerStorage});
      const create: MutationEnvelope = {operation: 'entries.Entry.create', operation_id: nextId(), inputs: {label: 'Composed entry'}};
      const revision = await binding.store.readRevision(), beforeCreate = await resources();
      const created = await invoker.invokeMutation(create, identity); assert.ok('result' in created, JSON.stringify(created));
      assert.equal(created.result.status, 'committed'); assert.equal(await binding.store.readRevision(), revision + 1);
      const rows = await binding.store.query({model: MODEL, authority: 'owner'}); assert.equal(rows.length, 1);
      assert.equal(rows[0]!.data.label, 'Composed entry');
      assert.equal((await binding.store.historyFor(MODEL, rows[0]!.id)).length, 1);
      const receipt = await binding.store.readReceipt({app: APP, owner: team.team_id, principal: user.user_id,
        operation: asOperation(create.operation), operationId: asOperationId(create.operation_id)}); assert.ok(receipt);
      assert.equal(receipt.outcome.status, 'committed');
      const afterCreate = await resources(); assert.deepEqual(afterCreate.identity, beforeCreate.identity);
      assert.deepEqual(afterCreate.files, beforeCreate.files); assert.deepEqual(afterCreate.intents, beforeCreate.intents);
      const replay = await invoker.invokeMutation(create, identity); assert.ok('result' in replay, JSON.stringify(replay));
      assert.equal(replay.result.status, 'replayed'); assert.deepEqual(await resources(), afterCreate);
      assert.equal(JSON.stringify(artifact), originalArtifact);
      assert.deepEqual(await Promise.all(paths.map(async path => hash(await readFile(path)))), originals);
    } finally { physical?.close(); await worker?.dispose(); await rm(dir, {recursive: true, force: true}); }
  });
