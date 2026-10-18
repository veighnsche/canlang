/** Original Contract input paths -> captured compiler -> installed native receiver -> real D1/Identity. */
import { createCheckoutScratch } from '../src/runtime/checkout-scratch.test-support.js';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
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
const APP = 'ContractInputs', CUSTOMER = asModel(`${APP}.Customer`), CONTACT = asModel(`${APP}.Contact`), LOCATION = asModel(`${APP}.Location`), RESULT = asModel(`${APP}.Result`), SNAPSHOT = asModel(`${APP}.Snapshot`), ASSIGNMENT = asModel(`${APP}.Assignment`), CHECKED = asModel(`${APP}.Checked`), INTAKE = asModel(`${APP}.Intake`);
const SOURCE = `app ContractInputs
Given
 Customer {active:bool,name:text}
 Contact in Customer {name:text}
 role contact_reader
 Location {title:text,currency:currency}
 Result {location:Location,title:text trim min=1,value:money,notes:text}
 contract Selection {location:Location,kind:text,model:text,id:text,version:int,recipient:email}
 contract Lead {customer:Customer,alternate:Customer,contact:Contact,selection:Selection,title:Result.title,value:money,notes:text,kind:text,model:text,id:text,version:int}
 Snapshot {input:Lead}
 Assignment {title:text,owner:user=actor}
 Checked {customer:Customer,contact:Contact,location:Location,value:money,owner:user=actor}
 Intake {source:text unique,input:Lead,checked:Checked,evidence:text min=1}
 lock Intake fields=source,input,checked,evidence
 invariant Checked: row.contact.parent==row.customer and row.value.minor>=0 and row.value.currency==row.location.currency
 policy Customer read=members
 policy Contact read=contact_reader
 policy Location read=members
 policy Result read=members
 policy Snapshot read=contact_reader
 policy Assignment read=contact_reader
 policy Checked read=members
 policy Intake read=contact_reader
When
 crud Customer by=members fields=active,name
 crud Contact by=members fields=name
 crud Location by=members fields=title,currency
 crud Assignment by=members fields=title,owner
 crud Checked by=members fields=customer,contact,location,value
 crud Intake by=members fields=source,input,checked,evidence create=none delete=none
 scenario promote(input:Lead,accept:bool) -> Result by=members
  require input.customer.active and input.alternate.active and input.contact.parent==input.customer and input.value.minor>=0 and input.value.currency==input.selection.location.currency
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
 scenario echoCurrency(currency:currency) -> currency by=members
  do
   return currency
 scenario capture(input:Lead,accept:bool) -> Snapshot by=members
  do
   create Snapshot {input} as snapshot
   require accept
   return snapshot
 scenario same(snapshot:Snapshot,input:Lead) -> bool by=members
  do
   return snapshot.input==input
 scenario requireSame(snapshot:Snapshot,input:Lead) -> bool by=members
  do
   require snapshot.input==input
   return true
 scenario check(input:Lead) -> Checked by=members
  do
   create Checked {customer=input.customer,contact=input.contact,location=input.selection.location,value=input.value} as checked
   return checked
 scenario upsert(source:text,input:Lead) -> Checked by=members
  require starts_with(source,"discover:") and source!="discover:"
  do
   let existing=first(Intake as intake where intake.source==source)
   if existing!=null
    require existing.input==input
    return existing.checked
   create Checked {customer=input.customer,contact=input.contact,location=input.selection.location,value=input.value} as checked
   create Intake {source,input,checked,evidence=input.notes} as intake
   return checked
 scenario assign(title:text,accept:bool) -> Assignment by=members
  do
   create Assignment {title} as assignment
   require accept
   return assignment
 scenario assignOther(title:text,owner:user) -> Assignment by=members
  do
   create Assignment {title,owner} as assignment
   return assignment
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
    const directory = await createCheckoutScratch(root, 'native-contract-inputs-');
    let worker: Miniflare | undefined;
    try {
      const sourcePath = join(directory, 'original-contract-inputs.can');
      await writeFile(sourcePath, SOURCE);
      const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { prepareLocalPreviewCapture } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { compileCapturedSingleFile } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root, appPath: sourcePath,
        compilerPath: join(root, 'compiler/target/debug/can'), catalogPath: fileURLToPath(distribution.catalog),
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('Original Contract input source did not compile');
      const artifact: CompileArtifact = compiled.artifact;
      assert.equal(verifyCompilerSources(capture, {complete:true,sources:artifact.sources}).ok, true);
      for (const name of ['promote', 'select', 'versions', 'echoCurrency', 'capture', 'same', 'requireSame', 'assign', 'assignOther', 'check', 'upsert']) {
        const operation = artifact.operations?.find(operation => operation.name === `${APP}.${name}`);
        assert.ok(operation?.result?.disclosure?.returns.length);
      }
      const checkedPolicy=artifact.modelPolicies?.find(policy=>policy.model===CHECKED);
      assert.ok(checkedPolicy);
      const checkedInvariant=checkedPolicy.rules.find(rule=>rule.kind==='invariant');
      assert.ok(checkedInvariant?.kind==='invariant');
      assert.deepEqual(new Set(checkedInvariant.dependencies.map(dependency=>dependency.model)),new Set([CONTACT,LOCATION]));
      assert.ok(checkedInvariant.dependencies.every(dependency=>Number.isSafeInteger(dependency.maxTargets)&&dependency.maxTargets>0));
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
      const location = await seed(LOCATION,{title:'original location',currency:'EUR'});
      assert.deepEqual(location.data,{title:'original location',currency:'EUR'});
      const ref = (row:typeof customer)=>({id:row.id,version:String(row.version)});
      const contact = await seed(CONTACT,{parent:ref(customer),name:'original contact'});
      const otherContact = await seed(CONTACT,{parent:ref(other),name:'other contact'});
      const payload = {customer:ref(customer),alternate:ref(customer),contact:ref(contact),selection:{location:ref(location),kind:'ref',model:'business-selection',id:'selection-id',version:'3',recipient:'selection@example.test'},
        kind:'ref',model:'business-lead',id:'lead-id',version:'7',title:'  reviewed  ',value:{minor:'500',currency:'EUR'},notes:'original evidence'};
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
      const currencyDependencies = association.plan.returns.flatMap(returned=>returned.dependencies)
        .filter(read=>read.model===LOCATION && read.field==='currency' && read.role==='control' && read.type==='currency');
      const currencyIds = new Set(currencyDependencies.map(read=>read.id)); assert.equal(currencyIds.size,1);
      const currencyReads = association.observations.filter(read=>currencyIds.has(read.dependencyId));
      assert.equal(currencyReads.length,1); assert.deepEqual(currencyReads[0]!.row,location);
      assert.equal(currencyReads[0]!.row.data.currency,'EUR');
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

      const echoedInput = envelope('echoCurrency',{currency:'EUR'});
      assert.equal(committed(await invoke(echoedInput)).result,'EUR');
      const echoedReceipt = await store.readReceipt(receiptIdentity(echoedInput)); assert.ok(echoedReceipt);
      const echoedAssociation = readScenarioReceiptAssociation(echoedReceipt); assert.ok(echoedAssociation);
      assert.deepEqual(echoedAssociation.changed,[]);
      assert.ok(echoedAssociation.intrinsics?.some(value=>value.kind==='admitted-input' && value.wire==='EUR'));
      const echoedCount = batches.length;
      assert.equal(committed(await invoke(echoedInput),'replayed').result,'EUR'); assert.equal(batches.length,echoedCount);
      const otherUser = await identities.createUser({email:'explicit-owner@example.test',password_hash:'unused',email_verified:true});
      const assignedCall = envelope('assign',{title:'Defaulted owner',accept:true});
      const assignmentId = referenceId(await invoke(assignedCall));
      const assignment = await store.load(ASSIGNMENT,asId(assignmentId)); assert.ok(assignment);
      assert.deepEqual(assignment.data,{title:'Defaulted owner',owner:{id:user.user_id}});
      const assignmentReceipt = await store.readReceipt(receiptIdentity(assignedCall)); assert.ok(assignmentReceipt);
      assert.deepEqual(Object.values(assignmentReceipt.resolvedDefaults),[{id:user.user_id}]);
      assert.ok(Object.keys(assignmentReceipt.resolvedDefaults)[0]!.endsWith('.owner'));
      const assignmentCount = batches.length;
      assert.equal(referenceId(await invoke(assignedCall),'replayed'),assignmentId); assert.equal(batches.length,assignmentCount);
      for (const call of [
        envelope('assignOther',{title:'Explicit scenario owner',owner:{id:otherUser.user_id}}),
        envelope(`${ASSIGNMENT}.create`,{title:'Explicit CRUD owner',owner:{id:otherUser.user_id}}),
        envelope(`${ASSIGNMENT}.create`,{title:'Defaulted CRUD owner'}),
      ]) {
        const result = committed(await invoke(call));
        const rowId = call.operation===`${ASSIGNMENT}.create` ? object(result.records![0]).id as string : object(result.result).id as string;
        const row = await store.load(ASSIGNMENT,asId(rowId)); assert.ok(row);
        assert.deepEqual(row.data.owner,{id:'owner' in call.inputs?otherUser.user_id:user.user_id});
        const receipt = await store.readReceipt(receiptIdentity(call)); assert.ok(receipt);
        assert.deepEqual(Object.values(receipt.resolvedDefaults),'owner' in call.inputs?[]:[{id:user.user_id}]);
        if(call.operation===`${ASSIGNMENT}.create` && 'owner' in call.inputs){
          const update=envelope(`${ASSIGNMENT}.update`,{record:ref(row),owner:{id:user.user_id}});
          committed(await invoke(update));
          assert.deepEqual((await store.load(ASSIGNMENT,row.id))!.data.owner,{id:user.user_id});
          const receipt=await store.readReceipt(receiptIdentity(update));assert.ok(receipt);assert.deepEqual(receipt.resolvedDefaults,{});
        }
      }
      const rejectedAssignment=envelope('assign',{title:'must roll back',accept:false});
      const beforeAssignments=await store.query({model:ASSIGNMENT,authority:'owner'}), assignmentFailures=batches.length;
      const rejected=await invoke(rejectedAssignment);assert.ok('error' in rejected);assert.equal(rejected.error.code,'rule_failed');
      assert.deepEqual(await store.query({model:ASSIGNMENT,authority:'owner'}),beforeAssignments);
      assert.equal(batches.length,assignmentFailures+1);assert.deepEqual(batches.at(-1)!.writes,[]);assert.deepEqual(batches.at(-1)!.history,[]);
      const rejectedReplay=await invoke(rejectedAssignment);assert.ok('error' in rejectedReplay);assert.equal(rejectedReplay.error.code,'rule_failed');
      assert.equal(batches.length,assignmentFailures+1);
      // The actual constructor stores the original whole Contract, preserving
      // typed reference identity rather than serializing hydrated business rows.
      const originalPayload = structuredClone(payload), snapshotCall = envelope('capture',{input:payload,accept:true});
      const snapshotId = referenceId(await invoke(snapshotCall));
      const savedSnapshot = await store.load(SNAPSHOT,asId(snapshotId)); assert.ok(savedSnapshot);
      const normalizedPayload = {...payload,title:'reviewed'};
      assert.deepEqual(savedSnapshot.data,{input:normalizedPayload}); assert.deepEqual(payload,originalPayload);
      const snapshotReceipt = await store.readReceipt(receiptIdentity(snapshotCall)); assert.ok(snapshotReceipt);
      const snapshotAssociation = readScenarioReceiptAssociation(snapshotReceipt); assert.ok(snapshotAssociation);
      assert.equal(snapshotAssociation.changed.length,1); assert.equal(snapshotAssociation.changed[0]!.row.id,snapshotId);
      const snapshotCount = batches.length;
      assert.equal(referenceId(await invoke(snapshotCall),'replayed'),snapshotId); assert.equal(batches.length,snapshotCount);
      const compareCall = envelope('same',{snapshot:ref(savedSnapshot),input:payload});
      assert.equal(committed(await invoke(compareCall)).result,true);
      const comparisonReceipt = await store.readReceipt(receiptIdentity(compareCall)); assert.ok(comparisonReceipt);
      const comparisonAssociation = readScenarioReceiptAssociation(comparisonReceipt); assert.ok(comparisonAssociation);
      assert.deepEqual(comparisonAssociation.changed,[]);
      assert.ok(comparisonAssociation.observations.some(read=>read.row.id===snapshotId && read.model===SNAPSHOT),JSON.stringify(comparisonAssociation));
      const comparisonCount = batches.length;
      assert.equal(committed(await invoke(compareCall),'replayed').result,true); assert.equal(batches.length,comparisonCount);
      assert.equal(committed(await invoke(envelope('requireSame',{snapshot:ref(savedSnapshot),input:payload}))).result,true);
      const beforeDifferent = await store.query({model:SNAPSHOT,authority:'owner'});
      const different = envelope('same',{snapshot:ref(savedSnapshot),input:{...payload,notes:'changed'}});
      assert.equal(committed(await invoke(different)).result,false);
      // A declared business version participates in equality even when its
      // containing Contract has every field of a runtime RecordRef.
      for (const changed of [
        {...payload,version:'8'},
        {...payload,selection:{...payload.selection,version:'4'}},
      ]) assert.equal(committed(await invoke(envelope('same',{snapshot:ref(savedSnapshot),input:changed}))).result,false);
      assert.deepEqual(await store.query({model:SNAPSHOT,authority:'owner'}),beforeDifferent);
      for (const rejectedCall of [
        envelope('capture',{input:payload,accept:false}),
        envelope('requireSame',{snapshot:ref(savedSnapshot),input:{...payload,notes:'changed'}}),
      ]) {
        const beforeSnapshots = await store.query({model:SNAPSHOT,authority:'owner'}), count = batches.length;
        const outcome = await invoke(rejectedCall); assert.ok('error' in outcome,JSON.stringify(outcome)); assert.equal(outcome.error.code,'rule_failed');
        assert.equal(batches.length,count+1);
        const batch = batches.at(-1)!; assert.deepEqual(batch.writes,[]); assert.deepEqual(batch.history,[]);
        assert.deepEqual(batch.outbox,[]); assert.deepEqual(batch.schedules,[]);
        assert.deepEqual(await store.query({model:SNAPSHOT,authority:'owner'}),beforeSnapshots);
        const replay = await invoke(rejectedCall); assert.ok('error' in replay); assert.equal(replay.error.code,'rule_failed');
        assert.equal(batches.length,count+1);
      }
      // Both CRUD Currency input and a standalone Currency scenario use the
      // installed canonical Values decoder, independently from money wires.
      for (const invalidCurrency of ['NOT','eur',123]) for (const operation of [`${LOCATION}.create`,'echoCurrency']) {
        const invalidInput = envelope(operation,operation===`${LOCATION}.create`
          ? {title:'must not persist',currency:invalidCurrency} : {currency:invalidCurrency});
        const beforeLocations = await store.query({model:LOCATION,authority:'owner'}), beforeResults = await records(), count = batches.length;
        const outcome = await invoke(invalidInput); assert.ok('error' in outcome,JSON.stringify(outcome));
        assert.equal(outcome.error.code,'validation');
        for (const batch of batches.slice(count)) {
          assert.deepEqual(batch.writes,[]); assert.deepEqual(batch.history,[]);
          assert.deepEqual(batch.outbox,[]); assert.deepEqual(batch.schedules,[]);
        }
        assert.deepEqual(await store.query({model:LOCATION,authority:'owner'}),beforeLocations);
        assert.deepEqual(await records(),beforeResults); assert.deepEqual(await store.load(LOCATION,location.id),location);
      }

      // The model invariant runs independently of scenario guards, through owner final-state reads.
      const checkedCall = envelope('check',{input:payload});
      const checkedId = referenceId(await invoke(checkedCall));
      const checkedRow = await store.load(CHECKED,asId(checkedId)); assert.ok(checkedRow);
      assert.deepEqual(checkedRow.data,{customer:{id:customer.id},contact:{id:contact.id},location:{id:location.id},value:payload.value,owner:{id:user.user_id}});
      const checkedCount = batches.length;
      assert.equal(referenceId(await invoke(checkedCall),'replayed'),checkedId); assert.equal(batches.length,checkedCount);
      // Two root constructors commit in source order; a new request reuses the original checked row.
      const pairedCall=envelope('upsert',{source:'discover:paired',input:payload}),pairedBefore=batches.length;
      const pairedId=referenceId(await invoke(pairedCall));
      assert.equal(batches.length,pairedBefore+1);
      const pairedBatch=batches.at(-1)!;
      assert.deepEqual(pairedBatch.writes.map(write=>write.model),[CHECKED,INTAKE]);
      assert.equal(pairedBatch.history.length,2);assert.equal(pairedBatch.uniqueClaims?.length,1);
      const intakeRows=await store.query({model:INTAKE,authority:'owner'});assert.equal(intakeRows.length,1);
      const intakeRow=intakeRows[0]!;
      assert.deepEqual(intakeRow.data,{source:'discover:paired',input:normalizedPayload,checked:{id:pairedId},evidence:payload.notes});
      const pairedReceipt=await store.readReceipt(receiptIdentity(pairedCall));assert.ok(pairedReceipt);
      const pairedAssociation=readScenarioReceiptAssociation(pairedReceipt);assert.ok(pairedAssociation);
      assert.deepEqual(Object.values(pairedReceipt.resolvedDefaults),[{id:user.user_id}]);
      assert.ok(Object.keys(pairedReceipt.resolvedDefaults)[0]!.endsWith('.owner'));
      assert.deepEqual((await store.load(CHECKED,asId(pairedId)))!.data.owner,{id:user.user_id});
      assert.deepEqual(new Set(pairedAssociation.changed.map(change=>change.model)),new Set([CHECKED,INTAKE]));
      assert.deepEqual(pairedAssociation.changed.find(change=>change.model===INTAKE)?.row,intakeRow);
      // All declared evidence fields remain locked through the canonical CRUD operation.
      for(const patch of [{source:'discover:changed'},{checked:ref(checkedRow)},{input:{...payload,notes:'changed'}},{input:{...payload,version:'8'}},{input:{...payload,selection:{...payload.selection,version:'4'}}},{evidence:'changed'}]) {
        const call=envelope(`${INTAKE}.update`,{record:ref(intakeRow),...patch}),before=batches.length;
        const outcome=await invoke(call);assert.ok('error' in outcome,JSON.stringify(outcome));assert.equal(outcome.error.code,'rule_failed');
        assert.equal(batches.length,before+1);assert.deepEqual(batches.at(-1)!.writes,[]);assert.deepEqual(batches.at(-1)!.history,[]);
        assert.deepEqual(await store.load(INTAKE,intakeRow.id),intakeRow);
      }
      const pairedExistingCall=envelope('upsert',{source:'discover:paired',input:payload}),reuseBefore=batches.length;
      assert.equal(referenceId(await invoke(pairedExistingCall)),pairedId);
      assert.equal(batches.length,reuseBefore+1);assert.deepEqual(batches.at(-1)!.writes,[]);assert.deepEqual(batches.at(-1)!.history,[]);
      const reusedReceipt=await store.readReceipt(receiptIdentity(pairedExistingCall));assert.ok(reusedReceipt);
      const reusedAssociation=readScenarioReceiptAssociation(reusedReceipt);assert.ok(reusedAssociation);
      assert.deepEqual(reusedAssociation.changed,[]);
      const replayBefore=batches.length;
      assert.equal(referenceId(await invoke(pairedCall),'replayed'),pairedId);
      assert.equal(referenceId(await invoke(pairedExistingCall),'replayed'),pairedId);assert.equal(batches.length,replayBefore);
      for(const [source,input,code] of [
        ['other:paired',payload,'rule_failed'],
        ['discover:',payload,'rule_failed'],
        ['discover:paired',{...payload,notes:'different evidence'},'rule_failed'],
        // Fixture-only required evidence fails in the second constructor after Checked has staged.
        ['discover:late-invalid',{...payload,notes:''},'validation'],
      ] as const) {
        const call=envelope('upsert',{source,input}),before=batches.length;
        const beforeChecked=await store.query({model:CHECKED,authority:'owner'});
        const rejected=await invoke(call);assert.ok('error' in rejected,JSON.stringify(rejected));assert.equal(rejected.error.code,code);
        assert.equal(batches.length,before+1);
        assert.deepEqual(batches.at(-1)!.writes,[]);assert.deepEqual(batches.at(-1)!.history,[]);
        assert.deepEqual(batches.at(-1)!.outbox,[]);assert.deepEqual(batches.at(-1)!.schedules,[]);
        assert.deepEqual(batches.at(-1)!.uniqueClaims??[],[]);
        assert.deepEqual(await store.query({model:CHECKED,authority:'owner'}),beforeChecked);
        assert.deepEqual(await store.query({model:INTAKE,authority:'owner'}),intakeRows);
        const rejectedReplay=await invoke(call);assert.ok('error' in rejectedReplay);assert.equal(rejectedReplay.error.code,code);
        assert.equal(batches.length,before+1);
      }
      for(const invalid of [
        {...payload,contact:ref(otherContact)},
        {...payload,value:{minor:'-1',currency:'EUR'}},
        {...payload,value:{minor:'500',currency:'USD'}},
      ]) {
        for(const call of [
          envelope('check',{input:invalid}),
          envelope(`${CHECKED}.create`,{customer:invalid.customer,contact:invalid.contact,location:invalid.selection.location,value:invalid.value}),
        ]) {
          const before=await store.query({model:CHECKED,authority:'owner'}),count=batches.length;
          const rejected=await invoke(call);assert.ok('error' in rejected,JSON.stringify(rejected));assert.equal(rejected.error.code,'rule_failed');
          assert.equal(batches.length,count+1);const batch=batches.at(-1)!;
          assert.deepEqual(batch.writes,[]);assert.deepEqual(batch.history,[]);assert.deepEqual(batch.outbox,[]);assert.deepEqual(batch.schedules,[]);
          assert.deepEqual(await store.query({model:CHECKED,authority:'owner'}),before);
          const replay=await invoke(call);assert.ok('error' in replay);assert.equal(replay.error.code,'rule_failed');assert.equal(batches.length,count+1);
        }
      }
      const badUpdate=envelope(`${CHECKED}.update`,{record:ref(checkedRow),value:{minor:'1',currency:'USD'}});
      const beforeUpdate=batches.length;
      const rejectedUpdate=await invoke(badUpdate);assert.ok('error' in rejectedUpdate);assert.equal(rejectedUpdate.error.code,'rule_failed');
      assert.deepEqual(await store.load(CHECKED,asId(checkedId)),checkedRow);
      assert.equal(batches.length,beforeUpdate+1);assert.deepEqual(batches.at(-1)!.writes,[]);

      // A referenced-row-only change must recheck the existing dependent invariant.
      const foreignUpdate=envelope(`${LOCATION}.update`,{record:ref(location),currency:'USD'});
      const beforeForeign=batches.length;
      const rejectedForeign=await invoke(foreignUpdate);assert.ok('error' in rejectedForeign,JSON.stringify(rejectedForeign));
      assert.equal(rejectedForeign.error.code,'rule_failed');assert.equal(batches.length,beforeForeign+1);
      assert.deepEqual(batches.at(-1)!.writes,[]);assert.deepEqual(batches.at(-1)!.history,[]);
      assert.deepEqual(await store.load(LOCATION,location.id),location);assert.deepEqual(await store.load(CHECKED,asId(checkedId)),checkedRow);
      const foreignReplay=await invoke(foreignUpdate);assert.ok('error' in foreignReplay);assert.equal(foreignReplay.error.code,'rule_failed');
      assert.equal(batches.length,beforeForeign+1);

      const unusedLocation=await seed(LOCATION,{title:'unreferenced location',currency:'EUR'});
      const unrelatedUpdate=envelope(`${LOCATION}.update`,{record:ref(unusedLocation),currency:'USD'});
      committed(await invoke(unrelatedUpdate));
      assert.equal((await store.load(LOCATION,unusedLocation.id))!.data.currency,'USD');
      assert.deepEqual(await store.load(CHECKED,asId(checkedId)),checkedRow);

      // Original early, parent, Currency correspondence and late guards each fail atomically.
      for (const bad of [
        {input:{...payload,customer:ref(blocked)},accept:true},
        {input:{...payload,contact:ref(otherContact)},accept:true},
        {input:{...payload,customer:ref(other)},accept:true},
        {input:{...payload,value:{minor:'500',currency:'USD'}},accept:true},
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
        [{...payload,selection:{...payload.selection,recipient:'not-an-email'}},'validation'],
        [{...payload,selection:{...payload.selection,recipient:42}},'validation'],
        [{...payload,customer:{id:customer.id}},'validation'],
        [{...payload,customer:{id:customer.id,version:String(customer.version+1)}},'conflict'],
        [{...payload,contact:{id:contact.id,version:String(contact.version+1)}},'conflict'],
        [{...payload,selection:{...payload.selection,location:{id:'missing-contract-location',version:'1'}}},'not_found'],
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
      for (const call of [snapshotCall,compareCall,assignedCall]) for (const recovered of [
        await invoke(call),await invoker.invokeRetainedMutation(call,await current()),
      ]) {
        const withheld = committed(recovered,'replayed'); assert.equal(withheld.result,null); assert.deepEqual(withheld.records,[]);
      }
      const hiddenReuse=committed(await invoker.invokeRetainedMutation(pairedExistingCall,await current()),'replayed');
      assert.equal(hiddenReuse.result,null);assert.deepEqual(hiddenReuse.records,[]);
      assert.equal(batches.length,grantCount); assert.deepEqual(await records(),grantRecords);
      await identities.setMembershipRoles(membership.membership_id,contactRoles);
      assert.equal(referenceId(await invoker.invokeRetainedMutation(input,await current()),'replayed'),id);
      assert.equal(referenceId(await invoker.invokeRetainedMutation(snapshotCall,await current()),'replayed'),snapshotId);
      assert.equal(committed(await invoker.invokeRetainedMutation(compareCall,await current()),'replayed').result,true);
      assert.equal(referenceId(await invoker.invokeRetainedMutation(assignedCall,await current()),'replayed'),assignmentId);
      assert.equal(batches.length,grantCount);
      assert.deepEqual(await store.load(CONTACT,contact.id),contact);
      assert.deepEqual(await store.load(CONTACT,otherContact.id),otherContact);
      assert.deepEqual(await store.load(CUSTOMER,customer.id),customer);
      assert.deepEqual(await store.load(LOCATION,location.id),location);
      assert.deepEqual((await store.load(LOCATION,location.id))!.data,{title:'original location',currency:'EUR'});
      await identities.removeMembership(membership.membership_id);
      const revokedCount = batches.length;
      const withheld = committed(await invoke(selectedInput),'replayed'); assert.equal(withheld.result,null);
      for (const call of [snapshotCall,compareCall,assignedCall,pairedCall,pairedExistingCall]) {
        const withheld = committed(await invoke(call),'replayed'); assert.equal(withheld.result,null); assert.deepEqual(withheld.records,[]);
        const denied = await invoker.invokeRetainedMutation(call,identity); assert.ok('error' in denied); assert.equal(denied.error.code,'forbidden');
      }
      const denied = await invoker.invokeRetainedMutation(selectedInput,identity); assert.ok('error' in denied); assert.equal(denied.error.code,'forbidden');
      const freshDenied = await invoke(envelope('promote',{input:payload,accept:true})); assert.ok('error' in freshDenied); assert.equal(freshDenied.error.code,'forbidden');
      assert.equal(batches.length,revokedCount);
      await identities.reactivateMembership(membership.membership_id,{is_owner:false,roles:contactRoles});
      assert.equal(referenceId(await invoker.invokeRetainedMutation(selectedInput,await current()),'replayed'),location.id);
      assert.equal(referenceId(await invoker.invokeRetainedMutation(snapshotCall,await current()),'replayed'),snapshotId);
      assert.equal(committed(await invoker.invokeRetainedMutation(compareCall,await current()),'replayed').result,true);
      assert.equal(referenceId(await invoker.invokeRetainedMutation(assignedCall,await current()),'replayed'),assignmentId);
      assert.equal(batches.length,revokedCount);
      assert.deepEqual(await store.load(SNAPSHOT,asId(snapshotId)),savedSnapshot);
      assert.deepEqual(await store.readReceipt(receiptIdentity(snapshotCall)),snapshotReceipt);
      assert.deepEqual(await store.readReceipt(receiptIdentity(compareCall)),comparisonReceipt);
      assert.deepEqual(await store.readReceipt(receiptIdentity(assignedCall)),assignmentReceipt);
      assert.deepEqual(await store.load(ASSIGNMENT,asId(assignmentId)),assignment);
      assert.equal(referenceId(await invoker.invokeRetainedMutation(pairedExistingCall,await current()),'replayed'),pairedId);
      assert.deepEqual(await store.query({model:INTAKE,authority:'owner'}),intakeRows);
      assert.deepEqual(await store.readReceipt(receiptIdentity(pairedCall)),pairedReceipt);
      assert.deepEqual(await store.readReceipt(receiptIdentity(input)),physical);
      // Concurrency metadata is not a business reference change in a locked Contract.
      const metadataCustomer=await seed(CUSTOMER,{active:true,name:'metadata customer'});
      const metadataContact=await seed(CONTACT,{parent:ref(metadataCustomer),name:'metadata contact'});
      const metadataPayload={...payload,customer:ref(metadataCustomer),alternate:ref(metadataCustomer),contact:ref(metadataContact)};
      const metadataPair=envelope('upsert',{source:'discover:metadata',input:metadataPayload});
      referenceId(await invoke(metadataPair));
      const metadataIntake=(await store.query({model:INTAKE,authority:'owner'})).find(row=>row.data.source==='discover:metadata');assert.ok(metadataIntake);
      committed(await invoke(envelope(`${CUSTOMER}.update`,{record:ref(metadataCustomer),name:'refreshed metadata customer'})));
      const refreshedCustomer=await store.load(CUSTOMER,metadataCustomer.id);assert.ok(refreshedCustomer);
      const refreshedPayload={...metadataPayload,customer:ref(refreshedCustomer),alternate:ref(refreshedCustomer)};
      committed(await invoke(envelope(`${INTAKE}.update`,{record:ref(metadataIntake),input:refreshedPayload})));
      const refreshedIntake=await store.load(INTAKE,metadataIntake.id);assert.ok(refreshedIntake);
      assert.deepEqual(refreshedIntake.data.input,{...refreshedPayload,title:'reviewed'});
      assert.deepEqual(refreshedIntake.data.checked,metadataIntake.data.checked);

      assert.equal(await readFile(sourcePath,'utf8'),SOURCE); assert.equal(await captureIsCurrent(capture),true);
    } finally {
      await worker?.dispose(); await rm(directory,{recursive:true,force:true});
    }
  });
