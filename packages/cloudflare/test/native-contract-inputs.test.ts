/** Original Contract input paths -> captured compiler -> installed native receiver -> real D1/Identity. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CommitBatch, CompileArtifact, MutationEnvelope, ReceiptIdentity, StoragePort } from '@canlang/contracts';
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { readScenarioReceiptAssociation } from '@canlang/state/invocation';
import { asId, asModel, asOperation, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { distribution } from '@canlang/values/distribution';
import type { MutationOutcome } from '../src/worker/assembly.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const nodeImport = compileFunction('return import(url)', ['url'], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const APP = 'ContractInputs', CUSTOMER = asModel(`${APP}.Customer`), CONTACT = asModel(`${APP}.Contact`), LOCATION = asModel(`${APP}.Location`), RESULT = asModel(`${APP}.Result`);
const SOURCE = `app ContractInputs
Given
 Customer {active:bool,name:text}
 Contact in Customer {name:text}
 role contact_reader
 Location {title:text}
 Result {location:Location,title:text trim min=1,value:money,notes:text}
 contract Selection {location:Location}
 contract Lead {customer:Customer,alternate:Customer,contact:Contact,selection:Selection,title:Result.title,value:money,notes:text}
 policy Customer read=members
 policy Contact read=contact_reader
 policy Location read=members
 policy Result read=members
When
 crud Customer by=members fields=active,name
 crud Contact by=members fields=name
 crud Location by=members fields=title
 scenario promote(input:Lead,accept:bool) -> Result by=members
  require input.customer.active and input.alternate.active and input.contact.parent==input.customer and input.value.minor>=0 and input.value.currency==input.value.currency
  do
   create Result {location=input.selection.location,title=input.title,value=input.value,notes=input.notes} as result
   require accept
   return result
 scenario select(input:Lead) -> Location by=members
  do
   return input.selection.location
 scenario versions(input:Lead) -> int by=members
  do
   return input.customer.version+input.alternate.version
Then
`;
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function committed(outcome: MutationOutcome, status: 'committed' | 'replayed' = 'committed') {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, status);
  return outcome.result;
}
function referenceId(outcome: MutationOutcome, status: 'committed' | 'replayed' = 'committed') {
  const result = committed(outcome, status), wire = object(result.result);
  assert.deepEqual(Object.keys(wire), ['id']); assert.equal(typeof wire.id, 'string');
  return wire.id as string;
}

test('native Contract input slots retain normalized values, distinct reference versions, rollback and current-authority replay',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(root, '.can-native-contract-inputs-'));
    let worker: Miniflare | undefined;
    try {
      const sourcePath = join(directory, 'original-contract-inputs.can');
      await writeFile(sourcePath, SOURCE);
      const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { prepareLocalPreviewCapture } = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
      const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
      const { compileCapturedSingleFile } = await nodeImport(installed('dev/compiler-check.js')) as typeof import('../src/dev/compiler-check.js');
      const capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root, appPath: sourcePath,
        compilerPath: join(root, 'compiler/target/debug/can'), catalogPath: fileURLToPath(distribution.catalog),
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('Original Contract input source did not compile');
      const artifact: CompileArtifact = compiled.artifact;
      assert.equal(verifyCompilerSources(capture, {complete:true,sources:artifact.sources}).ok, true);
      for (const name of ['promote', 'select', 'versions']) {
        const operation = artifact.operations?.find(operation => operation.name === `${APP}.${name}`);
        assert.ok(operation?.result?.disclosure?.returns.length);
      }
      const asm = await assembleModules({artifact,sourcePath}, {workDir:join(directory,'modules'),stdlibUrl:installed('runtime/stdlib.js')});
      worker = new Miniflare({ compatibilityDate:'2026-07-15',modules:true,
        script:'export default { fetch() { return new Response("ok"); } }',
        d1Databases:{IDENTITY:'contract-input-identity',OWNER:'contract-input-owner'},d1Persist:join(directory,'d1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      const now = Date.now(), clock = {nowMs:()=>now}, identities = createD1IdentityStore(identityDb,{clock});
      const team = await identities.createTeam({timezone:'UTC'});
      const user = await identities.createUser({email:'contract-input@example.test',password_hash:'unused',email_verified:true});
      const contactRoles = [{role:`${APP}.contact_reader`,granted_at:new Date(now).toISOString(),granted_by:user.user_id}];
      const membership = await identities.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:false,roles:contactRoles});
      const token = `contract-input-${user.user_id}`;
      await identities.createSession({user_id:user.user_id,token_sha256:await sha256HexText(token),last_team_id:team.team_id,
        expires_at:new Date(now+3600_000).toISOString()});
      const current = ()=>resolveIdentity(identities,{session_token:token},{clock});
      const identity = await current();
      const underlying = createD1Storage(ownerDb), batches: CommitBatch[] = [];
      const store: StoragePort = {...underlying,async commit(batch) {
        const result = await underlying.commit(batch); batches.push(batch); return result;
      }};
      const invoker = buildInvoker(artifact,asm,store,{appId:APP,memberships:identities,source:'http',now:clock.nowMs});
      let sequence = 0;
      const envelope = (name:string,inputs:MutationEnvelope['inputs']): MutationEnvelope => ({
        operation:name.includes('.')?name:`${APP}.${name}`,operation_id:uuidv7(now,++sequence),inputs });
      const invoke = (input:MutationEnvelope)=>invoker.invokeMutation(input,identity);
      const receiptIdentity = (input:MutationEnvelope): ReceiptIdentity => ({app:APP,owner:team.team_id,principal:membership.user_id,
        operation:asOperation(input.operation),operationId:asOperationId(input.operation_id)});
      async function seed(model:typeof CUSTOMER,inputs:MutationEnvelope['inputs']) {
        const result = committed(await invoke(envelope(`${model}.create`,inputs)));
        const projected = object(result.records![0]);
        const row = await store.load(model,asId(projected.id as string)); assert.ok(row); return row;
      }
      const customer = await seed(CUSTOMER,{active:true,name:'member'});
      const blocked = await seed(CUSTOMER,{active:false,name:'blocked'});
      const other = await seed(CUSTOMER,{active:true,name:'other customer'});
      const location = await seed(LOCATION,{title:'original location'});
      const ref = (row:typeof customer)=>({id:row.id,version:String(row.version)});
      const contact = await seed(CONTACT,{parent:ref(customer),name:'original contact'});
      const otherContact = await seed(CONTACT,{parent:ref(other),name:'other contact'});
      const payload = {customer:ref(customer),alternate:ref(customer),contact:ref(contact),selection:{location:ref(location)},
        title:'  reviewed  ',value:{minor:'500',currency:'EUR'},notes:'original evidence'};
      const records = ()=>store.query({model:RESULT,authority:'owner'});
      const createdBefore = await records();
      const input = envelope('promote',{input:payload,accept:true});
      const id = referenceId(await invoke(input));
      const created = await store.load(RESULT,asId(id)); assert.ok(created);
      assert.equal(created.data.title,'reviewed');
      assert.deepEqual(created.data.value,{minor:'500',currency:'EUR'});
      assert.equal(created.data.notes,'original evidence');
      assert.equal(object(created.data.location).id,location.id);
      assert.equal((await records()).length,createdBefore.length+1);
      const physical = await store.readReceipt(receiptIdentity(input)); assert.ok(physical);
      const association = readScenarioReceiptAssociation(physical); assert.ok(association);
      const activeIds = new Set(association.plan.returns.flatMap(returned=>returned.dependencies)
        .filter(read=>read.model===CUSTOMER && read.field==='active').map(read=>read.id));
      const activeReads = association.observations.filter(read=>activeIds.has(read.dependencyId));
      assert.equal(activeReads.length,2); assert.equal(new Set(activeReads.map(read=>read.dependencyId)).size,2);
      assert.ok(activeReads.every(read=>read.row.id===customer.id));
      const parentDependencies = association.plan.returns.flatMap(returned=>returned.dependencies)
        .filter(read=>read.model===CONTACT && read.field==='parent' && read.role==='control');
      const parentIds = new Set(parentDependencies.map(read=>read.id));
      assert.equal(parentIds.size,1);
      const parentReads = association.observations.filter(read=>parentIds.has(read.dependencyId));
      assert.equal(parentReads.length,1); assert.deepEqual(parentReads[0]!.row,contact);
      assert.deepEqual(parentReads[0]!.row.parent,{model:CUSTOMER,id:customer.id});
      assert.equal(association.changed.length,1); assert.equal(association.changed[0]!.row.id,id);
      const afterCommit = batches.length, committedRecords = await records(), committedHistory = await store.historyFor(RESULT,asId(id));
      assert.equal(referenceId(await invoke(input),'replayed'),id);
      assert.equal(referenceId(await invoker.invokeRetainedMutation(input,identity),'replayed'),id);
      assert.equal(batches.length,afterCommit); assert.deepEqual(await records(),committedRecords);
      assert.deepEqual(await store.historyFor(RESULT,asId(id)),committedHistory);

      const selectedInput = envelope('select',{input:payload});
      assert.equal(referenceId(await invoke(selectedInput)),location.id);
      const versionsInput = envelope('versions',{input:payload});
      assert.equal(committed(await invoke(versionsInput)).result,String(customer.version*2));
      const versionsReceipt = await store.readReceipt(receiptIdentity(versionsInput)); assert.ok(versionsReceipt);
      const versionAssociation = readScenarioReceiptAssociation(versionsReceipt); assert.ok(versionAssociation);
      assert.equal(versionAssociation.intrinsics?.length,2);
      assert.equal(new Set(versionAssociation.intrinsics?.map(value=>value.dependencyId)).size,2);
      assert.ok(versionAssociation.intrinsics?.every(value=>value.kind==='admitted-reference-version' && value.row.id===customer.id));

      // Original early, parent-correspondence and late guards each fail atomically.
      for (const bad of [
        {input:{...payload,customer:ref(blocked)},accept:true},
        {input:{...payload,contact:ref(otherContact)},accept:true},
        {input:{...payload,customer:ref(other)},accept:true},
        {input:payload,accept:false},
      ]) {
        const call = envelope('promote',bad), before = await records(), count = batches.length;
        const result = await invoke(call); assert.ok('error' in result); assert.equal(result.error.code,'rule_failed');
        assert.equal(batches.length,count+1);
        const batch = batches.at(-1)!; assert.deepEqual(batch.writes,[]); assert.deepEqual(batch.history,[]);
        assert.deepEqual(batch.outbox,[]); assert.deepEqual(batch.schedules,[]); assert.deepEqual(await records(),before);
        const saved = await store.readReceipt(receiptIdentity(call)); assert.ok(saved); assert.equal(saved.outcome.status,'rejected');
        const replay = await invoke(call); assert.ok('error' in replay); assert.equal(replay.error.code,'rule_failed');
        assert.equal(batches.length,count+1);
      }
      for (const [invalid,code] of [
        [{...payload,customer:{id:customer.id}},'validation'],
        [{...payload,customer:{id:customer.id,version:String(customer.version+1)}},'conflict'],
        [{...payload,contact:{id:contact.id,version:String(contact.version+1)}},'conflict'],
        [{...payload,selection:{location:{id:'missing-contract-location',version:'1'}}},'not_found'],
      ] as const) {
        const call = envelope('promote',{input:invalid,accept:true}), count = batches.length, revision = await store.readRevision(), before = await records();
        const outcome = await invoke(call); assert.ok('error' in outcome,JSON.stringify(outcome)); assert.equal(outcome.error.code,code);
        assert.equal(batches.length,count); assert.equal(await store.readRevision(),revision);
        assert.deepEqual(await records(),before); assert.equal(await store.readReceipt(receiptIdentity(call)),null);
      }
      // Current Contact read authority is independent from operation membership.
      await identities.setMembershipRoles(membership.membership_id,[]);
      const grantCount = batches.length, grantRecords = await records();
      for (const recovered of [await invoke(input),await invoker.invokeRetainedMutation(input,await current())]) {
        const withheld = committed(recovered,'replayed'); assert.equal(withheld.result,null); assert.deepEqual(withheld.records,[]);
      }
      assert.equal(batches.length,grantCount); assert.deepEqual(await records(),grantRecords);
      await identities.setMembershipRoles(membership.membership_id,contactRoles);
      assert.equal(referenceId(await invoker.invokeRetainedMutation(input,await current()),'replayed'),id);
      assert.equal(batches.length,grantCount);
      assert.deepEqual(await store.load(CONTACT,contact.id),contact);
      assert.deepEqual(await store.load(CONTACT,otherContact.id),otherContact);
      assert.deepEqual(await store.load(CUSTOMER,customer.id),customer);
      await identities.removeMembership(membership.membership_id);
      const revokedCount = batches.length;
      const withheld = committed(await invoke(selectedInput),'replayed'); assert.equal(withheld.result,null);
      const denied = await invoker.invokeRetainedMutation(selectedInput,identity); assert.ok('error' in denied); assert.equal(denied.error.code,'forbidden');
      const freshDenied = await invoke(envelope('promote',{input:payload,accept:true})); assert.ok('error' in freshDenied); assert.equal(freshDenied.error.code,'forbidden');
      assert.equal(batches.length,revokedCount);
      await identities.reactivateMembership(membership.membership_id,{is_owner:false,roles:contactRoles});
      assert.equal(referenceId(await invoker.invokeRetainedMutation(selectedInput,await current()),'replayed'),location.id);
      assert.equal(batches.length,revokedCount);
      assert.deepEqual(await store.readReceipt(receiptIdentity(input)),physical);
      assert.equal(await readFile(sourcePath,'utf8'),SOURCE); assert.equal(await captureIsCurrent(capture),true);
    } finally {
      await worker?.dispose(); await rm(directory,{recursive:true,force:true});
    }
  });
