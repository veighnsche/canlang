/** New explicit literal-default/bounded-alias CALL input leaf only.
 * The accepted int/text default-root C04 test is intentionally unchanged.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CommitBatch, ModelName, MutationEnvelope, OperationId, OperationName, ReceiptIdentity, StoragePort } from '@canlang/contracts';
import type { MutationOutcome } from '../src/worker/assembly.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const require = createRequire(import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const producer = (specifier: string) => pathToFileURL(require.resolve(specifier)).href;
const APP = 'NativeExplicitInputs', MODEL = `${APP}.Run` as ModelName;
const fixture = join(root, 'packages/cloudflare/test/fixtures/native-explicit-call-inputs.can');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function snapshot(db: D1Database) {
  const names = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name: string}>();
  assert.equal(names.success, true);
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const { name } of names.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true); result[name] = rows.results.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
function committed(outcome: MutationOutcome, status: 'committed' | 'replayed' = 'committed') {
  assert.ok('result' in outcome, JSON.stringify(outcome)); assert.equal(outcome.result.status, status);
  const wire = object(outcome.result.result); assert.deepEqual(Object.keys(wire), ['id']); assert.equal(typeof wire.id, 'string');
  return { id: wire.id as string, result: outcome.result };
}

test('original explicit scalar default and bounded alias CALL inputs retain one D1 fence, rollback and current replay',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-native-explicit-call-inputs-'));
    let worker: Miniflare | undefined;
    try {
      // Genuine default-loader registry/capability identities for ALL runtime
      // adapters and producer APIs, not a Vitest-interpreted generated module.
      const { assembleModules, importVerifiedAssemblyModule } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { loadCanonicalDescriptors } = await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
      const { prepareLocalPreviewCapture } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { captureSingleFileSource, captureIsCurrent, verifyCompilerSources } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { parseArtifactText } = await nodeImport(installed('runtime/artifact.js')) as typeof import('../src/runtime/artifact.js');
      const { distribution } = await nodeImport(producer('@canlang/values/distribution')) as typeof import('@canlang/values/distribution');
      const { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } = await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
      const { createD1Storage, ensureSchema } = await nodeImport(producer('@canlang/state/storage/d1')) as typeof import('@canlang/state/storage/d1');
      const { readScenarioReceiptAssociation } = await nodeImport(producer('@canlang/state/invocation')) as typeof import('@canlang/state/invocation');
      const { hashInputs } = await nodeImport(producer('@canlang/state/invocation/replay')) as typeof import('@canlang/state/invocation/replay');
      const { uuidv7 } = await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
      const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
      const paths = [fixture, compiler, catalog], originals = await Promise.all(paths.map(async path => digest(await readFile(path))));
      const capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root, appPath: fixture,
        compilerPath: compiler, catalogPath: catalog, helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
      assert.equal(capture.sourceSha256, originals[0]);
      for (const [name, path, hash] of [['compiler', compiler, originals[1]], ['catalog', catalog, originals[2]]] as const) {
        const input = capture.inputs.find(input => input.name === name); assert.ok(input);
        assert.equal(input.state, 'present'); assert.equal(input.requestedPath, path); assert.equal(input.sha256, hash);
      }
      assert.equal(await captureIsCurrent(capture), true);
      // This platform native control uses original std field declarations.
      // Dev's first-slice admission deliberately excludes those imports; keep
      // that admission unchanged and invoke the actual captured CLI directly.
      const env = { ...process.env }; delete env.CAN_CATALOG;
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, capture.compilerOperand],
        { cwd: capture.root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      assert.equal(await captureIsCurrent(capture), true);
      assert.deepEqual(await Promise.all(paths.map(async path => digest(await readFile(path)))), originals);
      const artifact = parseArtifactText(stdout, fixture).artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      assert.equal(artifact.sources.find(source => resolve(source.path) === fixture)?.sha256, originals[0]);
      const asm = await assembleModules({ artifact, sourcePath: fixture }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      const generatedBytes = new Map(await Promise.all(Object.entries(asm.moduleUrls).map(async ([path,url]) => [path, await readFile(fileURLToPath(url))] as const)));
      const loaded = await loadCanonicalDescriptors(asm, artifact);
      const operation = (name: string) => { const found = artifact.operations?.find(operation => operation.name === `${APP}.${name}`); assert.ok(found); return found; };
      const generate = operation('generate'), choice = operation('choice');
      for (const [name,value] of [['negative',''],['width','512'],['height','512']] as const) {
        const field = generate.inputs.fields.find(field => field.name === name); assert.ok(field);
        assert.equal(field.required, false); assert.deepEqual(field.default, { kind: 'literal', value });
        assert.equal(field.computedDefault === true, false);
        const canonicalInputs = object(object(loaded.registry.get(generate.name)).descriptor).inputs; assert.ok(Array.isArray(canonicalInputs));
        const original = canonicalInputs.find(field => object(field).name === name); assert.ok(original); const canonical = object(original);
        assert.equal(canonical.required, field.required); assert.equal(canonical.valueType, field.valueType); assert.deepEqual(canonical.default, field.default);
      }
      const alias = choice.inputs.fields[0]!;
      assert.equal(alias.field.kind, 'nominal'); assert.equal(alias.valueType, `${APP}.Choice.pick.choice`);
      assert.equal(alias.required, false); assert.deepEqual(alias.default, { kind: 'literal', value: 'fallback' });
      const owningAlias = loaded.valueTypes?.aliases?.find(value => value.name === alias.valueType); assert.ok(owningAlias);
      assert.equal(owningAlias.type, 'text'); assert.equal(owningAlias.min, 1); assert.equal(owningAlias.max, 80); assert.equal(owningAlias.format, 'name');
      const sites = new Map<string, Record<string, unknown>>();
      for (const [parent,child] of [['from_turn','generate'],['chosen','choice']] as const) {
        const callable = artifact.callables.find(callable => callable.id === `${APP}.${parent}`); assert.ok(callable);
        const module = object(await importVerifiedAssemblyModule(asm, callable.module, artifact)); assert.equal(module[callable.export], callable.id);
        const declaration = object(object(object(module.appDefinition).operations)[callable.id]);
        assert.ok(Array.isArray(declaration.callSites)); assert.equal(declaration.callSites.length, 1);
        const site = object(declaration.callSites[0]); sites.set(parent,site);
        assert.deepEqual(site.targets, [`${APP}.${child}`]); assert.equal(site.resultType, MODEL);
        assert.deepEqual(site.source, operation(parent).result!.disclosure!.source);
        assert.match(artifact.modules.find(module => module.path === callable.module)!.js, /await bindScenarioReceiptModelResult\(c,/);
      }
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default {fetch(){return new Response("ok")}}', d1Persist: join(directory,'d1'),
        d1Databases: { IDENTITY: 'explicit-inputs-identity', OWNER: 'explicit-inputs-owner', FOREIGN: 'explicit-inputs-foreign' } });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      const foreignDb = await worker.getD1Database('FOREIGN') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb); await ensureSchema(foreignDb);
      const now = Date.parse('2026-10-11T14:00:00Z'), clock = { nowMs: () => now };
      const identities = createD1IdentityStore(identityDb,{clock}), team = await identities.createTeam({timezone:'UTC'});
      const user = await identities.createUser({email:'explicit-inputs@example.test',password_hash:'unused',email_verified:true});
      const membership = await identities.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:false,roles:[]});
      const token = 'original-explicit-inputs-credential';
      await identities.createSession({user_id:user.user_id,token_sha256:await sha256HexText(token),last_team_id:team.team_id,
        expires_at:new Date(now+3600000).toISOString()});
      const current = () => resolveIdentity(identities,{session_token:token},{clock}), identity = await current();
      const underlying = createD1Storage(ownerDb), foreign = createD1Storage(foreignDb), batches: CommitBatch[] = [];
      const store: StoragePort = {...underlying,async commit(batch){const result=await underlying.commit(batch);batches.push(batch);return result;}};
      const invoker = buildInvoker(artifact,asm,store,{appId:APP,memberships:identities,source:'http',now:clock.nowMs});
      const resources = async () => ({identity:await snapshot(identityDb),owner:await snapshot(ownerDb),foreign:await snapshot(foreignDb)});
      let sequence=0;
      const envelope = (name:string,inputs:MutationEnvelope['inputs']):MutationEnvelope => ({operation:`${APP}.${name}`,operation_id:uuidv7(now,++sequence),inputs});
      const receiptIdentity = (input:MutationEnvelope):ReceiptIdentity => ({app:APP,owner:team.team_id,principal:user.user_id,
        operation:input.operation as OperationName,operationId:input.operation_id as OperationId});
      const inputs = [envelope('from_turn',{prompt:'Explicit original prompt',negative:'supplied negative',width:'1024',height:'768',accept:true}),
        envelope('chosen',{value:'other',accept:true})];
      const retained: Array<{input:MutationEnvelope;id:string}> = [];
      for (const input of inputs) {
        const before=await resources(),revision=await store.readRevision(),count=batches.length;
        const result=committed(await invoker.invokeMutation(input,identity));retained.push({input,id:result.id});
        assert.equal(batches.length,count+1);assert.equal(await store.readRevision(),revision+1);
        const batch=batches.at(-1)!;assert.equal(batch.expectedRevision,revision);assert.equal(batch.writes.length,1);
        assert.ok(batch.receipt);assert.deepEqual(batch.receipt.identity,receiptIdentity(input));
        assert.equal(batch.writes[0]!.kind,'insert');assert.equal(batch.writes[0]!.model,MODEL);assert.equal(batch.history.length,1);
        const row=await store.load(MODEL,result.id as Parameters<StoragePort['load']>[1]);assert.ok(row);
        assert.deepEqual(row.data,{count:'0'});assert.equal(row.version,1);assert.equal(row.createdBy,user.user_id);
        assert.deepEqual(batch.history[0]!.after,row.data);assert.equal(batch.history[0]!.before,null);
        assert.equal(batch.history[0]!.actor,user.user_id);assert.equal(batch.history[0]!.operationId,input.operation_id);
        assert.deepEqual(await store.historyFor(MODEL,row.id),batch.history);
        const child=input.operation.endsWith('.from_turn')?'generate':'choice',parent=input.operation.split('.').at(-1)!;
        assert.equal(batch.history[0]!.operation,`${APP}.${child}`);
        const physical=await store.readReceipt(receiptIdentity(input));assert.ok(physical);
        assert.equal(physical.inputHash,await hashInputs(input.inputs));assert.equal(physical.committedRevision,revision+1);
        const association=readScenarioReceiptAssociation(physical);assert.ok(association);
        assert.deepEqual(association.plan,operation(parent).result!.disclosure);assert.equal(association.resultType,MODEL);
        assert.deepEqual(association.changed.map(change=>change.row),[row]);assert.equal(association.calls?.length,1);
        const call=association.calls![0]!;assert.equal(call.site,sites.get(parent)!.id);assert.equal(call.caller,input.operation);
        assert.equal(call.target,`${APP}.${child}`);assert.deepEqual(call.result,{id:row.id});assert.ok(call.scenario);
        assert.deepEqual(call.scenario.plan,operation(child).result!.disclosure);assert.equal(call.scenario.resultType,MODEL);
        for(const key of ['outbox','schedules','uniqueClaims','uniqueReleases','outboxAck'] as const)assert.deepEqual(batch[key]??[],[]);
        const after=await resources();assert.deepEqual(after.identity,before.identity);assert.deepEqual(after.foreign,before.foreign);
        for(const table of Object.keys(before.owner))if(!['records','history','receipts','fence','fence_log','sqlite_sequence'].includes(table))
          assert.deepEqual(after.owner[table],before.owner[table],table);
        assert.deepEqual(after.owner.records!.filter(saved=>saved.id!==row.id),before.owner.records);
        assert.equal(after.owner.receipts!.length,before.owner.receipts!.length+1);assert.equal(after.owner.history!.length,before.owner.history!.length+1);
        assert.equal(after.owner.fence_log!.length,before.owner.fence_log!.length+1);
        assert.equal(committed(await invoker.invokeRetainedMutation(input,identity),'replayed').id,row.id);
        assert.deepEqual(await resources(),after);assert.equal(batches.length,count+1);
      }
      // The child's real Create is staged before this authored refusal. The
      // parent owns one rejected receipt/fence and rolls back ALL child effects.
      for(const input of [envelope('from_turn',{prompt:'rollback',negative:'explicit',width:'512',height:'512',accept:false}),
        envelope('chosen',{value:'other',accept:false})]) {
        const before=await resources(),count=batches.length,revision=await store.readRevision();
        const refused=await invoker.invokeMutation(input,identity);assert.ok('error' in refused,JSON.stringify(refused));
        const receipt=await store.readReceipt(receiptIdentity(input));assert.ok(receipt);assert.equal(receipt.outcome.status,'rejected');
        assert.equal(receipt.inputHash,await hashInputs(input.inputs));assert.equal(receipt.committedRevision,revision+1);
        assert.equal(batches.length,count+1);const batch=batches.at(-1)!;assert.equal(batch.expectedRevision,revision);
        assert.deepEqual(batch.writes,[]);assert.deepEqual(batch.history,[]);assert.deepEqual(batch.outbox,[]);assert.deepEqual(batch.schedules,[]);
        const after=await resources();assert.deepEqual(after.identity,before.identity);assert.deepEqual(after.foreign,before.foreign);
        assert.deepEqual(after.owner.records,before.owner.records);assert.deepEqual(after.owner.history,before.owner.history);
        assert.equal(after.owner.receipts!.length,before.owner.receipts!.length+1);assert.equal(after.owner.fence_log!.length,before.owner.fence_log!.length+1);
        const replay=await invoker.invokeMutation(input,identity);assert.ok('error' in replay);
        assert.deepEqual(await resources(),after);assert.equal(batches.length,count+1);
      }
      // A default on the owning child is metadata, never permission to omit
      // an explicitly authored parent input. No omitted-default CALL is added.
      const missing=envelope('from_turn',{prompt:'missing',negative:'explicit',height:'512',accept:true});
      const missingBefore=await resources(),missingCount=batches.length;
      assert.ok('error' in await invoker.invokeMutation(missing,identity));
      assert.deepEqual(await resources(),missingBefore);assert.equal(batches.length,missingCount);
      await identities.removeMembership(membership.membership_id);
      const revoked=await resources();
      for(const {input} of retained){const denied=await invoker.invokeRetainedMutation(input,identity);assert.ok('error' in denied);
        assert.equal(denied.error.code,'forbidden');assert.deepEqual(await resources(),revoked);}
      await identities.reactivateMembership(membership.membership_id,{is_owner:false,roles:[]});
      const restored=await current(),stable=await resources();
      for(const {input,id} of retained){assert.equal(committed(await invoker.invokeRetainedMutation(input,restored),'replayed').id,id);
        assert.deepEqual(await resources(),stable);}
      assert.equal((await store.query({model:MODEL,authority:'owner'})).length,2);
      assert.deepEqual(await foreign.query({model:MODEL,authority:'owner'}),[]);
      assert.equal(JSON.stringify(artifact),originalArtifact);assert.equal(await captureIsCurrent(capture),true);
      assert.deepEqual(await Promise.all(paths.map(async path=>digest(await readFile(path)))),originals);
      for(const [path,bytes]of generatedBytes)assert.deepEqual(await readFile(fileURLToPath(asm.moduleUrls[path]!)),bytes);
    } finally {try {await worker?.dispose();} finally {await rm(directory,{recursive:true,force:true});}}
  });
