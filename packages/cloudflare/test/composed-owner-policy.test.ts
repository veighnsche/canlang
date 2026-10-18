/** Installed composition of the original model_rule_origins declarations.
 * Only the labelled authenticated CRUD setup is test-authored. Negative
 * variants corrupt actual emitted metadata; none supplies replacement rules. */
import { createCheckoutScratch } from '../src/dev/checkout-scratch.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, ModelName, MutationEnvelope, StoredRow } from '@canlang/contracts';
import type { MutationOutcome } from '../src/worker/assembly.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const require = createRequire(import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const producer = (name: string) => pathToFileURL(require.resolve(name)).href;
const APP = 'ComposedOwnerPolicies';
const setup = (fields: string) => `  ## BEGIN TEST-AUTHORED SETUP: authenticated CRUD only\n  crud Item by=members fields=${fields}\n${fields.includes('closed') ? '  crud Bin by=members fields=qty,title,closed\n' : ''}  ## END TEST-AUTHORED SETUP\n`;
function own(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
function committed(value: MutationOutcome) {
  assert.ok('result' in value, JSON.stringify(value)); assert.equal(value.result.status, 'committed'); return value.result;
}
async function compileOriginalComposition(directory: string) {
  const {distribution} = await nodeImport(producer('@canlang/values/distribution')) as typeof import('@canlang/values/distribution');
  const original = await readFile(join(root, 'compiler/tests/model_rule_origins.rs'), 'utf8');
  const literal = /let source = ("package Office\\n[^\n]+?");/.exec(original); assert.ok(literal, 'exact owning Rust source literal');
  const declarations = JSON.parse(literal[1]!) as string;
  assert.equal(declarations.split('When\n').length, 3);
  const officeSetup = setup('qty,title,closed'), warehouseSetup = setup('qty,title');
  let occurrence = 0;
  const body = declarations.replace(/When\n/g, () => `When\n${occurrence++ === 0 ? officeSetup : warehouseSetup}`);
  assert.equal(body.replace(officeSetup, '').replace(warehouseSetup, ''), declarations);
  const sourcePath = join(directory, 'composed-owner-policy.can');
  await writeFile(sourcePath, `app ${APP} uses=[Office,Warehouse]\n${body}`);
  const env = {...process.env}; delete env.CAN_CATALOG;
  let stdout: string;
  try {
    ({stdout} = await promisify(execFile)(join(root, 'compiler/target/debug/can'), ['compile', '--format=json', '--catalog', fileURLToPath(distribution.catalog), sourcePath],
      {cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024}));
  } catch (error) {
    const failure = error as Error & {stdout?: string; stderr?: string};
    assert.fail(`Original composed policy CLI failed: ${failure.message}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`);
  }
  return {artifact: JSON.parse(stdout) as CompileArtifact, sourcePath};
}

test('installed original conditional unique refuses before checked native adoption', {timeout: 90000}, async () => {
  const directory = await createCheckoutScratch(root, 'composed-owner-policy-refusal-');
  try {
    const {artifact, sourcePath} = await compileOriginalComposition(directory);
    const {assembleModules} = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
    const {loadCanonicalDescriptors} = await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
    const assembly = await assembleModules({artifact, sourcePath}, {workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js'), uiUrl: producer('@canlang/ui')});
    await assert.rejects(loadCanonicalDescriptors(assembly, artifact), /Conditional unique source requires checked native adoption/);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('installed colliding Item rules and unique Bin retain original legacy keys, enforcement and closed coverage', {timeout: 180000}, async () => {
  const directory = await createCheckoutScratch(root, 'composed-owner-policy-');
  let worker: Miniflare | undefined;
  try {
    const {assembleModules, importVerifiedAssemblyModule} = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
    const {loadCanonicalDescriptors} = await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
    const {buildInvoker, createTeamOwnerStorageBoundary} = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
    const {createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity} = await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
    const {ensureSchema} = await nodeImport(producer('@canlang/state/storage/d1')) as typeof import('@canlang/state/storage/d1');
    const {createD1OwnerRouter} = await nodeImport(producer('@canlang/state/storage/owner-router')) as typeof import('@canlang/state/storage/owner-router');
    const {uuidv7} = await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
    const {artifact, sourcePath} = await compileOriginalComposition(directory);
    const descriptors = artifact.modelPolicies!; assert.equal(descriptors.length, 3);
    const office = descriptors.find(value => value.model === 'Office.Item')!, bin = descriptors.find(value => value.model === 'Office.Bin')!, warehouse = descriptors.find(value => value.model === 'Warehouse.Item')!;
    assert.ok(office && bin && warehouse);
    assert.deepEqual(office.rules.map(rule => [rule.kind, rule.id]), [['lock', 'Office.Office.Item.lock.1'], ['invariant', 'Office.Office.Item.require.1'], ['invariant', 'Office.Office.Item.require.2']]);
    assert.deepEqual(bin.rules.map(rule => [rule.kind, rule.id]), [['invariant', 'Office.Bin.require.1'], ['lock', 'Office.Bin.lock.1']]);
    assert.deepEqual(warehouse.rules.map(rule => [rule.kind, rule.id]), [['invariant', 'Warehouse.Warehouse.Item.require.1'], ['lock', 'Warehouse.Warehouse.Item.lock.1']]);
    const assembly = await assembleModules({artifact, sourcePath}, {workDir: join(directory, 'positive'), stdlibUrl: installed('runtime/stdlib.js'), uiUrl: producer('@canlang/ui')});
    await loadCanonicalDescriptors(assembly, artifact);
    const namespace = own(await importVerifiedAssemblyModule(assembly, office.module, artifact));
    const registry = own((namespace.canApp as () => unknown)());
    const invariants = own(registry.invariants), locks = own(registry.locks);
    for (const key of ['Office.Item.require.1', 'Office.Item.require.2', 'Warehouse.Item.require.1', 'Bin.require.1']) assert.equal(typeof invariants[key], 'function', key);
    for (const key of ['Office.Item.lock.1', 'Warehouse.Item.lock.1', 'Bin.lock.1']) assert.ok(locks[key], key);
    assert.equal(invariants['Item.require.1'], undefined, 'collision cannot use a bare Item key');
    assert.ok(invariants['Office.Item.unique.1'], 'original conditional unique remains in its owning registry');

    worker = new Miniflare({compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: {IDENTITY: 'composed-identity', OWNER: 'composed-owner'}});
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database, db = await worker.getD1Database('OWNER') as unknown as D1Database;
    await ensureIdentitySchema(identityDb); await ensureSchema(db);
    const now = Date.now(), clock = {nowMs: () => now}, identities = createD1IdentityStore(identityDb, {clock});
    const team = await identities.createTeam({timezone: 'UTC'}), user = await identities.createUser({email: 'owner@composition.example.test', password_hash: 'unused', email_verified: true});
    await identities.createMembership({user_id: user.user_id, team_id: team.team_id, is_owner: false, roles: []});
    const grant = await issueMcpGrant(identities, {user_id: user.user_id, team_id: team.team_id, client_id: 'composition'}, {clock});
    const identity = await resolveIdentity(identities, {mcp_grant_token: grant.token}, {clock});
    const ownerStorage = await createTeamOwnerStorageBoundary({artifact, asm: assembly, app: APP, identities,
      router: createD1OwnerRouter({resolveBinding: selected => selected.app === APP && selected.owner === team.team_id ? {...selected, db, initializeFresh: true} : null})});
    const store = await ownerStorage.forIdentity(identity), invoker = buildInvoker(artifact, assembly, store, {appId: APP, memberships: identities, source: 'http', now: clock.nowMs, ownerStorage});
    let sequence = 0;
    const envelope = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({operation, operation_id: uuidv7(now, ++sequence), inputs});
    const create = async (model: string, inputs: MutationEnvelope['inputs']): Promise<StoredRow> => {
      const result = committed(await invoker.invokeMutation(envelope(`${model}.create`, inputs), identity));
      assert.ok(result.records); assert.equal(result.records.length, 1);
      const record = own(result.records[0]); assert.equal(typeof record.id, 'string');
      const row = await store.load(model as ModelName, record.id as StoredRow['id']); assert.ok(row); return row;
    };
    const rejected = async (operation: string, inputs: MutationEnvelope['inputs'], row?: StoredRow) => {
      const model = operation.split('.').slice(0, -1).join('.') as ModelName;
      const beforeRows = await store.query({model, authority: 'owner'});
      const before = row === undefined ? undefined : await store.load(model, row.id);
      const result = await invoker.invokeMutation(envelope(operation, inputs), identity); assert.ok('error' in result, JSON.stringify(result)); assert.equal(result.error.code, 'rule_failed');
      assert.deepEqual(await store.query({model, authority: 'owner'}), beforeRows);
      if (row !== undefined) assert.deepEqual(await store.load(model, row.id), before);
    };
    const item = await create('Office.Item', {qty: '1', title: 'office', closed: false}), other = await create('Warehouse.Item', {qty: '1', title: 'warehouse'}), openBin = await create('Office.Bin', {qty: '1', title: 'bin', closed: false});
    await rejected('Office.Item.create', {qty: '-1', title: 'bad', closed: false}); await rejected('Office.Item.create', {qty: '101', title: 'too high', closed: false});
    await rejected('Warehouse.Item.create', {qty: '-1', title: 'bad'}); await rejected('Office.Bin.create', {qty: '-1', title: 'bad', closed: false});
    for (const [model, row] of [['Office.Item', item], ['Warehouse.Item', other]] as const) await rejected(`${model}.update`, {record: {id: row.id, version: String(row.version)}, title: 'changed'}, row);
    committed(await invoker.invokeMutation(envelope('Office.Bin.update', {record: {id: openBin.id, version: String(openBin.version)}, title: 'open change', closed: true}), identity));
    const closedBin = await store.load('Office.Bin' as ModelName, openBin.id); assert.ok(closedBin);
    await rejected('Office.Bin.update', {record: {id: closedBin.id, version: String(closedBin.version)}, title: 'closed change'}, closedBin);
    // Tamper only emitted identities/coverage. Original predicate functions
    // and authenticated CRUD source remain intact in every negative module.
    const mutations: Record<string, string> = {
      'wrong-owner': "r.modelPolicyBindings=r.modelPolicyBindings.map((b,i)=>i===0?{...b,ownerPackage:'Warehouse'}:b);",
      'wrong-module': "r.modelPolicyBindings=r.modelPolicyBindings.map((b,i)=>i===0?{...b,module:'foreign.mjs'}:b);",
      'wrong-model': "r.modelPolicyBindings=r.modelPolicyBindings.map((b,i)=>i===0?{...b,model:'Warehouse.Item'}:b);",
      'swapped-collision-key': "r.policy.models['Office.Item'].invariants=['Warehouse.Item.require.1','Office.Item.require.2'];",
      'wrong-kind': "r.modelPolicyBindings=r.modelPolicyBindings.map((b,i)=>i===0?{...b,kind:b.kind==='lock'?'invariant':'lock'}:b);",
      'wrong-ordinal': "r.modelPolicyBindings=r.modelPolicyBindings.map((b,i)=>i===0?{...b,id:b.id.replace(/\\.1$/,'.9')}:b);",
      'missing-native-binding': 'r.modelPolicyBindings=r.modelPolicyBindings.slice(1);',
      'duplicate-native-binding': 'r.modelPolicyBindings=[...r.modelPolicyBindings,r.modelPolicyBindings[0]];',
      'lock-fields': "r.locks={...r.locks,'Office.Item.lock.1':{...r.locks['Office.Item.lock.1'],fields:['qty']}};",
      'malformed-metadata': "Object.defineProperty(r.modelPolicyBindings[0],'model',{get(){throw Error('accessor executed');}});",
    };
    for (const [label, map] of [
      ['definition-models', 'appDefinition.models'],
      ['registry-policy-models', 'r.policy.models'],
      ['definition-policy-models', 'appDefinition.policy.models'],
    ]) {
      mutations[`missing-coverage-${label}`] = `${map}['Office.Item'].invariants=[];`;
      mutations[`duplicate-coverage-${label}`] = `${map}['Office.Item'].invariants.push(${map}['Office.Item'].invariants[0]);`;
    }
    const naming = {
      'bare-colliding-item': { model: 'Office.Item', descriptor: 'Office.Office.Item.require.1', renamed: 'Office.Item.require.1', legacy: 'Office.Item.require.1', renamedLegacy: 'Item.require.1' },
      'qualified-unique-bin': { model: 'Office.Bin', descriptor: 'Office.Bin.require.1', renamed: 'Office.Office.Bin.require.1', legacy: 'Bin.require.1', renamedLegacy: 'Office.Bin.require.1' },
    };
    for (const [mode, value] of Object.entries(naming)) {
      const literal = (text: string) => JSON.stringify(text);
      mutations[mode] = `r.modelPolicyBindings=r.modelPolicyBindings.map(b=>b.id===${literal(value.descriptor)}?{...b,id:${literal(value.renamed)}}:b);` +
        `r.invariants={...r.invariants,[${literal(value.renamedLegacy)}]:r.invariants[${literal(value.legacy)}]};delete r.invariants[${literal(value.legacy)}];` +
        ['appDefinition.models', 'r.policy.models', 'appDefinition.policy.models'].map(map =>
          `${map}[${literal(value.model)}].invariants=${map}[${literal(value.model)}].invariants.map(id=>id===${literal(value.legacy)}?${literal(value.renamedLegacy)}:id);`).join('');
    }
    for (const [mode, mutation] of Object.entries(mutations)) {
      const altered = structuredClone(artifact), emitted = altered.modules.find(value => value.path === office.module)!;
      const rename = naming[mode as keyof typeof naming];
      if (rename !== undefined) {
        const descriptor = altered.modelPolicies!.find(value => value.model === rename.model)!;
        const rule = descriptor.rules.find(value => value.id === rename.descriptor); assert.ok(rule);
        Object.defineProperty(rule, 'id', {value: rename.renamed, enumerable: true, writable: true, configurable: true});
      }
      assert.equal(emitted.js.split('export function canApp(){').length, 2);
      emitted.js = emitted.js.replace('export function canApp(){', 'function $originalCanApp(){') + `\nexport function canApp(){const r=$originalCanApp();${mutation}return r;}\n`;
      const badAssembly = await assembleModules({artifact: altered, sourcePath}, {workDir: join(directory, mode), stdlibUrl: installed('runtime/stdlib.js'), uiUrl: producer('@canlang/ui')});
      const revision = await store.readRevision();
      await assert.rejects(loadCanonicalDescriptors(badAssembly, altered), error =>
        error instanceof Error && !error.message.includes('accessor executed') &&
          (rename === undefined || /convention/i.test(error.message)), mode);
      assert.equal(await store.readRevision(), revision, `${mode}: refusal before owner activation`);
    }
    await create('Office.Item', {qty: '7', title: 'unique', closed: true});
    const beforeUnique = await store.query({model: 'Office.Item' as ModelName, authority: 'owner'});
    const duplicate = await invoker.invokeMutation(envelope('Office.Item.create', {qty: '7', title: 'duplicate', closed: true}), identity);
    assert.ok('error' in duplicate, 'original conditional unique must enforce');
    assert.deepEqual(await store.query({model: 'Office.Item' as ModelName, authority: 'owner'}), beforeUnique);
  } finally { await worker?.dispose(); await rm(directory, {recursive: true, force: true}); }
});
