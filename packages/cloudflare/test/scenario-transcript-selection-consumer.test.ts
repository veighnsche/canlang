/** Test-authored installed Dev transcript-selection component; no Compiler/native app claim.
 * Reuses the prefix component loader/Identity/StateMemory/SQLiteFiles setup and
 * the released State selected-message declaration/IDs; tests the actual host join. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants } from 'node:vm';
import { test } from 'vitest';
import type { CanTypeId, CompileArtifact, ModelName, OperationId, Receipt, StoredRow } from '@canlang/contracts';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const require = createRequire(import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const producer = (specifier: string) => pathToFileURL(require.resolve(specifier)).href;
const APP = 'SelectedMessages', CONVERSATION = 'SelectedMessages.Conversation' as ModelName,
  BRANCH = 'SelectedMessages.Branch' as ModelName, TURN = 'SelectedMessages.Turn' as ModelName,
  RUN = 'SelectedMessages.Run' as ModelName, OP = 'SelectedMessages.collect';
const TYPE = 'std.TextMessage[]' as CanTypeId, ROLE = 'std.TextMessage.role' as CanTypeId;
const source = 'selected-messages-component.can', modulePath = 'selected-messages.mjs';
const sourceText = '## Test-authored installed transcript selection component; no compiled Can claim.';
const sha256 = createHash('sha256').update(sourceText).digest('hex');
const origin = { path: source, sha256, module: modulePath };
const retention = { unattachedHorizonMs: 60_000, retentionMs: 120_000 };
let sequence = 124_000;
type Mode = 'valid' | 'copy' | 'pending';
const mapping = [{ name: 'role', field: 'role', type: ROLE },
  { name: 'content', field: 'content', type: 'text' as CanTypeId },
  { name: 'attachments', field: 'attachments', type: 'file[]' as CanTypeId }];
function artifact(mode: Mode): CompileArtifact {
  // Exact released owning State declaration/ID separation, not Compiler292
  // emitted admission. Corrected literal Compiler/native output remains held.
  const valueTypes = { contracts: [{ name: 'std.TextMessage', fields: [
    { name: 'role', type: ROLE }, { name: 'content', type: 'text' as CanTypeId, max: 100 },
    { name: 'attachments', type: 'file[]' as CanTypeId, max: 8 },
  ] }], enums: [{ name: ROLE, cases: ['system', 'user', 'assistant'] }] };
  const modelFields: Readonly<Record<string, Readonly<Record<string, { readonly type: string }>>>> = { [CONVERSATION]: { title: { type: 'text' } }, [BRANCH]: { title: { type: 'text' } },
    [TURN]: { role: { type: ROLE }, content: { type: 'text' }, attachments: { type: 'file[]' }, position: { type: 'int' } },
    [RUN]: { count: { type: 'int' } } };
  const rules = Object.keys(modelFields).map(model => ({ model, rule: `${model.split('.').at(-1)}.read.1` }));
  const policy = { operations: { [OP]: { by: ['members'] } }, models: Object.fromEntries(rules.map(({model,rule})=>[model,{read:[rule]}])) };
  const selections = [{ queryId: 'messages', type: TYPE,
    fields: mapping.map(field => ({ name: field.name, dependencyId: `q-${field.name}` })) }];
  const definition = { id: APP, policy, contracts: { 'std.TextMessage': { fields: {
    role: { type: ROLE }, content: { type: 'text', max: 100 }, attachments: { type: 'file[]', max: 8 },
  } } }, enums: { [ROLE]: { cases: ['system', 'user', 'assistant'] } },
    models: Object.fromEntries(rules.map(({model,rule})=>[model,{fields:modelFields[model],
      readGrants:[{rule,by:['members'],fields:Object.keys(modelFields[model]!)}]}])),
    operations: { [OP]: { handler: OP, inputs: { branch: { type: BRANCH } }, querySelections: selections } } };
  const selection = mode === 'valid' ? `const bound=await bindScenarioReceiptQuerySelection(c,rows,messages);if(bound!==messages)throw Error('host copied original eager messages');`
    : mode === 'copy' ? `try{await bindScenarioReceiptQuerySelection(c,[...rows],messages);}catch(error){refusals.push(error.message);}
      try{await bindScenarioReceiptQuerySelection(c,rows,messages);}catch(error){refusals.push(error.message);}`
    : `const started=bindScenarioReceiptQuerySelection(c,rows,messages);void started.catch(()=>{});
      try{await bindScenarioReceiptQuerySelection(c,rows,messages);}catch(error){refusals.push(error.message);}
      try{await started;}catch(error){refusals.push(error.message);}`;
  const js = `import {hasRole,count,encodeValue,create,set,executeScenarioReceiptQuery,observeScenarioReceiptQueryDependency,
 bindScenarioReceiptQuerySelection,bindScenarioReceiptModelResult,selectScenarioReceiptReturn} from '@canlang/stdlib';
let executions=0,predicates=0;const snapshots=[],refusals=[];
export const controls=()=>({executions,predicates,snapshots,refusals});
export const appDefinition=${JSON.stringify(definition)};
export function canApp(){return {policy:appDefinition.policy,read:{${rules.map(({rule})=>`${JSON.stringify(rule)}:c=>hasRole(c,'members')`).join(',')}},SelectedMessages:{
collect:async(c,input)=>{executions++;
 // Stage through the genuine public create seam before selection so caught
 // host failures must roll back an actual business creation, never a mock.
 const run=await create(c,${JSON.stringify(RUN)},{parent:input.branch,count:0n});
 const rows=await executeScenarioReceiptQuery(c,'messages',row=>{predicates++;
  const position=row.position;observeScenarioReceiptQueryDependency(c,${JSON.stringify(TURN)},row,'position','position-control');return position<3n;});
 const messages=rows.map(row=>{
  const role=row.role;observeScenarioReceiptQueryDependency(c,${JSON.stringify(TURN)},row,'role','data-role');
  const content=row.content;observeScenarioReceiptQueryDependency(c,${JSON.stringify(TURN)},row,'content','data-content');
  const attachments=row.attachments;observeScenarioReceiptQueryDependency(c,${JSON.stringify(TURN)},row,'attachments','data-attachments');
  return {role,content,attachments};});
 ${selection}
 snapshots.push(encodeValue(${JSON.stringify(TYPE)},messages));
 await set(c,run,{count:count(messages)});
 const result=await bindScenarioReceiptModelResult(c,'created-run',run);selectScenarioReceiptReturn(c,'created-run');return result;
}}};}`;
  return { artifact_version: 1, language_version: 'test-authored installed component', tool_version: 'consumer fixture',
    sources: [{ path: source, sha256 }], modules: [{ path: modulePath, js,
      map: { version: 3, file: modulePath, sources: [source], sourcesContent: [sourceText], names: [], mappings: '' } }],
    requires: [{ capability: 'canlang.builtins', min_version: 2 }, { capability: 'state', min_version: 1 },
      { capability: 'state.parameters', min_version: 1 }], pages: [], tests: [], valueTypes,
    models: [{ name: CONVERSATION, deleteMode: 'archive', fields: [
      { name: 'title', field: { kind: 'string' }, required: true, serverOnly: false },
    ] }, { name: BRANCH, parent: CONVERSATION, deleteMode: 'archive', fields: [
      { name: 'title', field: { kind: 'string' }, required: true, serverOnly: false },
    ] }, { name: TURN, parent: BRANCH, deleteMode: 'archive', fields: [
      { name: 'role', field: { kind: 'enum', values: ['system','user','assistant'] }, valueType: ROLE, required: true, serverOnly: false },
      { name: 'content', field: { kind: 'string' }, valueType: 'text' as CanTypeId, max: 100, required: true, serverOnly: false },
      { name: 'attachments', field: { kind: 'file' }, valueType: 'file[]' as CanTypeId, array: { required: false }, max: 8, required: false, serverOnly: false },
      { name: 'position', field: { kind: 'integer' }, valueType: 'int' as CanTypeId, required: true, serverOnly: false },
    ] }, { name: RUN, parent: BRANCH, deleteMode: 'archive', fields: [
      { name: 'count', field: { kind: 'integer' }, valueType: 'int' as CanTypeId, required: true, serverOnly: false },
    ] }], operations: [
      ...rules.map(({ model }) => ({ name: `${model}.read`, kind: 'read' as const,
        description: '', inputs: { fields: [] } })),
      { name: OP, kind: 'scenario', description: '', inputs: { fields: [
      { name: 'branch', field: { kind: 'ref', model: BRANCH, requireVersion: true }, required: true },
    ] }, result: { type: RUN as CanTypeId, disclosure: { version: 1, source: origin,
      queries: [{ id: 'messages', source: origin, model: TURN,
        parent: { source: origin, model: BRANCH, origin: { kind: 'admitted-reference', parameter: 'branch' } },
        order: [{ field: 'position', direction: 'asc' }], limit: null, archived: 'exclude', dependencies: [
          { id: 'position-control', source: origin, role: 'control', field: 'position', type: 'int' as CanTypeId },
          ...mapping.map(field=>({id:`data-${field.name}`,source:origin,role:'data' as const,field:field.field,type:field.type})),
        ] }], returns: [{ id: 'created-run', source: origin,
        influences: (['query-existence','query-cardinality','query-membership','query-order'] as const)
          .map(kind=>({id:`messages-${kind}`,kind,queryId:'messages'})),
        dependencies: mapping.map(field=>({id:`q-${field.name}`,queryId:'messages',source:origin,role:'data' as const,
          model:TURN,field:field.field,type:field.type})),
      }] } } }], callables: [{ id: OP, kind: 'operation', module: modulePath, export: 'collect',
      member: ['SelectedMessages','collect'], inputStyle: 'parameters' }],
  };
}
function hold() {
  let begin!: () => void, release!: () => void;
  const started = new Promise<void>(done => { begin = done; }), released = new Promise<void>(done => { release = done; });
  return { started, begin, released, release };
}
async function world(options: { domain?: 'empty' | 'empty-attachments'; mode?: Mode; pause?: ReturnType<typeof hold> } = {}) {
  // One genuine installed loader for every issuer/assembler/consumer WeakMap.
  const { assembleModules, importVerifiedAssemblyModule } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
  const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
  const { createCanonicalFileBinding } = await nodeImport(installed('runtime/bound-files.js')) as typeof import('../src/runtime/bound-files.js');
  const { DEFAULT_FILE_POLICY, blobKeyForFile, ingestVerifiedEventBytes } = await nodeImport(producer('@canlang/files')) as typeof import('@canlang/files');
  const { createSqliteFileBindings, createSqliteFileStore } = await nodeImport(producer('@canlang/files/host/sqlite')) as typeof import('@canlang/files/host/sqlite');
  const { createFileJourneyKernel } = await nodeImport(producer('@canlang/interfaces/uploads/kernel')) as typeof import('@canlang/interfaces/uploads/kernel');
  const { createFrozenClock, createMemoryIdentityStore } = await nodeImport(producer('@canlang/identity/testing')) as typeof import('@canlang/identity/testing');
  const { resolveIdentity, sha256HexText } = await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
  const { readScenarioReceiptAssociation } = await nodeImport(producer('@canlang/state/invocation')) as typeof import('@canlang/state/invocation');
  const { createTestMemoryStorage } = await nodeImport(producer('@canlang/state/storage/memory')) as typeof import('@canlang/state/storage/memory');
  const { FIXED_NOW, seedRow, makeRow, makeBatch, uuidv7 } = await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
  const directory = await mkdtemp(join(tmpdir(), 'can-selected-messages-component-'));
  const physical = createSqliteFileStore(join(directory, 'files.sqlite'));
  try {
    const compiled = artifact(options.mode ?? 'valid'), originalArtifact = JSON.stringify(compiled);
    const asm = await assembleModules({ artifact: compiled, sourcePath: source }, { workDir: join(directory, 'modules'),
      stdlibUrl: installed('runtime/stdlib.js') });
    const clock = createFrozenClock(FIXED_NOW), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({});
    const user = await identities.createUser({ email: 'selected-member@example.test', password_hash: 'unused', email_verified: true });
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = randomBytes(32).toString('hex');
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(FIXED_NOW + 86400000).toISOString(), last_team_id: team.team_id });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const receiver = { app: APP, team: team.team_id, owner: team.team_id, principal: user.user_id };
    const fileNow = FIXED_NOW;
    const fileClock = { nowMs: () => fileNow }, bytes = new TextEncoder().encode('original prefix receiving bytes\n');
    const refs = [0, 1].map(itemIndex => {
      const finalized = ingestVerifiedEventBytes({ clock: fileClock, files: physical.files, blobs: physical.blobs,
        intents: physical.intents, fileIds: { nextFileId: () => randomUUID() } }, {
        provenance: { kind: 'event', source: 'deployment.mail', adapter: 'deployment.mail', occurrenceId: randomUUID(),
          fieldPath: 'attachments', itemIndex }, receiver, claimedType: 'text/plain', bytes, policy: DEFAULT_FILE_POLICY,
      });
      assert.equal(finalized.status, 'finalized'); if (finalized.status !== 'finalized') throw new Error('Files finalization refused');
      return finalized.file.id;
    });
    const kernel = createFileJourneyKernel(createSqliteFileBindings(physical, {
      clock: fileClock, intentTtlMs: 60000, urlBase: 'https://prefix-files.invalid',
    }));
    const observedRefs: string[] = [];
    let gated = false;
    const observedKernel = { ...kernel, observeFile: async (...args: Parameters<typeof kernel.observeFile>) => {
      observedRefs.push(args[0]);
      // Delegate to the actual owning issuer. The control only pauses its
      // response, never creates/replaces facts or reimplements traversal.
      const fact = await kernel.observeFile(...args);
      if (options.pause !== undefined && !gated) { gated = true; options.pause.begin(); await options.pause.released; }
      return fact;
    } };
    const files = createCanonicalFileBinding(observedKernel, retention);
    const { store, probe } = createTestMemoryStorage();
    const conversation = await seedRow(store, CONVERSATION, { id: 'conversation', data: { title: 'Original conversation' } });
    const row: StoredRow = { ...makeRow({ id: 'branch', data: { title: 'Original branch' } }), parent: { model: CONVERSATION, id: conversation.id } };
    const other: StoredRow = { ...makeRow({ id: 'other', data: { title: 'Other branch' } }), parent: row.parent ?? null };
    await store.commit(makeBatch(await store.readRevision(), { writes: [row,other].map(row=>({kind:'insert' as const,model:BRANCH,row})) }));
    for (const [id,position,role,content,attachments] of [
      ['second','2','assistant','Second',[]],
      ['first','1','user','First',options.domain==='empty-attachments'?[]:[{id:refs[1]!},{id:refs[0]!},{id:refs[1]!}]],
      ['false','3','user','False candidate',[]],
    ] as const) {
      const turn: StoredRow = {...makeRow({id,data:{position,role,content,attachments}}),
        parent:{model:BRANCH,id:options.domain==='empty'?other.id:row.id}};
      await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:TURN,row:turn}]}));
    }
    const expected = options.domain==='empty'?[]:[
      {role:'user',content:'First',attachments:options.domain==='empty-attachments'?[]:[{id:refs[1]},{id:refs[0]},{id:refs[1]}]},
      {role:'assistant',content:'Second',attachments:[]},
    ];
    const ns = await importVerifiedAssemblyModule(asm, modulePath, compiled) as {
      controls: () => { executions:number;predicates:number;snapshots:unknown[];refusals:string[] };
    };
    const env = { operation: OP, operation_id: uuidv7(FIXED_NOW, ++sequence), inputs: { branch: { id: row.id, version: String(row.version) } } };
    const receiptIdentity: Receipt['identity'] = { app: APP, owner: team.team_id, principal: user.user_id,
      operation: OP as Receipt['identity']['operation'], operationId: env.operation_id as OperationId };
    const snapshot = async () => ({ revision: await store.readRevision(),
      rows: await Promise.all([CONVERSATION,BRANCH,TURN,RUN].map(model=>store.query({model,authority:'owner',archived:'include'}))),
      history: (await store.query({model:RUN,authority:'owner',archived:'include'})).map(row=>probe.historyFor(RUN,row.id)), outbox: probe.outboxAll(), schedules: await store.schedulesDue(Number.MAX_SAFE_INTEGER, 100),
      receipt: await store.readReceipt(receiptIdentity), files: physical.files.listAll(), intents: physical.intents.listAll(),
      bytes: refs.map(ref => physical.blobs.read(blobKeyForFile(ref))) });
    let replayCommits = 0;
    const readonlyStore = { ...store, commit: async () => { replayCommits++; throw Error('Selection replay attempted a business commit'); } };
    const invoker = (saved=false) => buildInvoker(compiled,asm,saved?readonlyStore:store,{appId:APP,memberships:identities,now:()=>FIXED_NOW,files});
    const invoke = () => invoker().invokeMutation(env,identity);
    const replay = () => invoker(true).invokeRetainedMutation(env,identity);
    return { compiled,originalArtifact,refs,expected,receiver,row,store,identities,membership,env,receiptIdentity,
      observedRefs,ns,invoke,replay,snapshot,readScenarioReceiptAssociation,replayCommits:()=>replayCommits,
      corruptBytes:()=>physical.blobs.write(blobKeyForFile(refs[0]!),new TextEncoder().encode('different retained bytes')),
      close: async () => { options.pause?.release(); physical.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { options.pause?.release(); physical.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}


type World = Awaited<ReturnType<typeof world>>;
async function assertRejected(w: World, before: Awaited<ReturnType<World['snapshot']>>,
  outcome: Awaited<ReturnType<World['invoke']>>) {
  assert.ok('error' in outcome,JSON.stringify(outcome));
  const after=await w.snapshot();assert.ok(after.receipt);
  assert.deepEqual(after.receipt.identity,w.receiptIdentity);
  assert.deepEqual(after.receipt.outcome,{status:'rejected',code:outcome.error.code,message:outcome.error.message});
  assert.equal(after.revision,before.revision+1);assert.equal(after.receipt.committedRevision,after.revision);
  assert.deepEqual({...after,receipt:before.receipt,revision:before.revision},before,'whole staged business effects rolled back; only one rejected receipt fence');
  assert.equal(w.ns.controls().executions,1);assert.equal(w.ns.controls().predicates,3);
  return outcome.error;
}

test('installed Dev selection joins original ordered/eager native arrays to real DATA/Files, empty wire and no-effect replay/current withholding', async()=>{
  for(const domain of [undefined,'empty-attachments','empty'] as const){
    const w=await world(domain===undefined?{}:{domain});
    try{
      const before=await w.snapshot(),outcome=await w.invoke();assert.ok('result' in outcome,JSON.stringify(outcome));
      assert.equal(outcome.result.status,'committed');
      assert.ok(outcome.result.result && typeof outcome.result.result==='object' && 'id' in outcome.result.result);
      const after=await w.snapshot(),run=after.rows[3]![0]!;assert.ok(run);
      assert.deepEqual(outcome.result.result,{id:run.id});assert.deepEqual(run.data,{count:domain==='empty'?'0':'2'});
      assert.equal(after.revision,before.revision+1);assert.equal(after.history.length,1);assert.equal(after.history[0]!.length,1);
      assert.deepEqual(after.rows.slice(0,3),before.rows.slice(0,3));
      for(const key of ['files','intents','bytes','outbox','schedules'] as const)assert.deepEqual(after[key],before[key]);
      const controls=w.ns.controls();assert.equal(controls.executions,1);assert.equal(controls.predicates,domain==='empty'?0:3);
      assert.deepEqual(controls.snapshots,[w.expected]);assert.deepEqual(controls.refusals,[]);
      assert.deepEqual(w.observedRefs,domain===undefined?[w.refs[1],w.refs[0]]:[]);
      const receipt=after.receipt!;const association=w.readScenarioReceiptAssociation(receipt);assert.ok(association);
      const query=association.queries![0]!;assert.deepEqual(query.selectedIndices.map(index=>query.candidates[index]!.row.id),domain==='empty'?[]:['first','second']);
      assert.deepEqual(association.observations.filter(item=>item.dependencyId==='q-content').map(item=>item.row.data.content),domain==='empty'?[]:['First','Second']);
      const attachments=association.observations.filter(item=>item.dependencyId==='q-attachments');
      assert.deepEqual(attachments.map(item=>item.files?.map(file=>file.ref)),domain==='empty'?[]:domain==='empty-attachments'?[[],[]]:[[w.refs[1],w.refs[0]],[]]);
      for(const item of attachments)for(const file of item.files??[])assert.deepEqual(file.receiver,w.receiver);
      const calls=[...w.observedRefs],replayed=await w.replay();assert.ok('result' in replayed,JSON.stringify(replayed));
      assert.equal(replayed.result.status,'replayed');assert.deepEqual(replayed.result.result,{id:run.id});
      assert.deepEqual(await w.snapshot(),after);assert.deepEqual(w.ns.controls(),controls);assert.deepEqual(w.observedRefs,calls);assert.equal(w.replayCommits(),0);
      if(domain===undefined){
        w.corruptBytes();const withheldBefore=await w.snapshot(),withheld=await w.replay();assert.ok('result' in withheld,JSON.stringify(withheld));
        assert.equal(withheld.result.status,'replayed');assert.equal(withheld.result.result,null);assert.deepEqual(withheld.result.records,[]);
        assert.deepEqual(await w.snapshot(),withheldBefore);assert.deepEqual(w.ns.controls(),controls);assert.deepEqual(w.observedRefs,calls);assert.equal(w.replayCommits(),0);
        assert.deepEqual(await w.store.readReceipt(w.receiptIdentity),receipt);
      }
      assert.equal(JSON.stringify(w.compiled),w.originalArtifact);
    }finally{await w.close();}
  }
});

test('copied native query arrays and caught pending selection failures stay terminal and roll back genuine staged creation',async()=>{
  for(const mode of ['copy','pending'] as const){
    const w=await world({mode});
    try{
      const before=await w.snapshot(),outcome=await w.invoke(),error=await assertRejected(w,before,outcome);
      assert.match(error.message,/selection|query|pending|sequential|completed/i);
      const refusals=w.ns.controls().refusals;assert.equal(refusals.length,2);assert.equal(refusals[0],refusals[1]);assert.equal(error.message,refusals[0]);
      const after=await w.snapshot(),controls=w.ns.controls(),calls=[...w.observedRefs],saved=await w.replay();
      assert.ok('error' in saved,JSON.stringify(saved));assert.equal(saved.error.message,error.message);
      assert.deepEqual(await w.snapshot(),after);assert.deepEqual(w.ns.controls(),controls);assert.deepEqual(w.observedRefs,calls);assert.equal(w.replayCommits(),0);
    }finally{await w.close();}
  }
});

test('actual selected Files await cannot commit staged business creation after current membership revocation',async()=>{
  const gate=hold(),w=await world({pause:gate});let pending:ReturnType<typeof w.invoke>|undefined;
  try{
    const before=await w.snapshot();pending=w.invoke();
    await Promise.race([gate.started,pending.then(result=>{throw Error('Invocation ended before actual selected receiving callback: '+JSON.stringify(result));})]);
    assert.deepEqual(w.observedRefs,[w.refs[1]]);
    await w.identities.removeMembership(w.membership.membership_id);gate.release();
    const outcome=await pending;pending=undefined;const error=await assertRejected(w,before,outcome);
    assert.equal(error.code,'forbidden');
    assert.equal(error.message,'Original whole stored File field is unavailable.');
    assert.deepEqual(w.ns.controls().snapshots,[]);
  }finally{gate.release();try{await pending;}finally{await w.close();}}
});
