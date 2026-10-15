/** Declaration-labelled component: genuine State admission/native views and
 * canonical stdlib Create. This makes no compiler source qualification claim. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import type { CanTypeId, CommitBatch, CompileArtifact, ModelName, MutationEnvelope, ReceiptIdentity, StoragePort } from '@canlang/contracts';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { FIXED_NOW, seedRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { assembleModules, importVerifiedAssemblyModule } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';

const APP = 'ContractSnapshots', CUSTOMER = `${APP}.Customer` as ModelName, LOCATION = `${APP}.Location` as ModelName,
  SNAPSHOT = `${APP}.Snapshot` as ModelName, OP = `${APP}.save`, MODULE = 'contract-snapshot.mjs';
const SOURCE = 'contract-snapshot-component.can', source = '## Declaration-labelled whole Contract snapshot component.';
const type = (name: string) => name as CanTypeId;
function declaration(): CompileArtifact {
  const operations: NonNullable<CompileArtifact['operations']> = [{name:OP,kind:'scenario',description:'',inputs:{fields:[
    {name:'request',field:{kind:'nominal',name:`${APP}.Request`},valueType:type(`${APP}.Request`),required:true},
    {name:'location',field:{kind:'ref',model:LOCATION,requireVersion:true},required:true},
    {name:'swap',field:{kind:'boolean'},valueType:'bool',required:true},
    {name:'accept',field:{kind:'boolean'},valueType:'bool',required:true},
  ]},result:{type:'void'}}];
  const fields = { [CUSTOMER]:{name:{type:'text'}},[LOCATION]:{name:{type:'text'}},[SNAPSHOT]:{input:{type:`${APP}.Request`}} };
  const policy = {operations:{[OP]:{by:['members']}},models:Object.fromEntries(Object.keys(fields).map(model=>[model,{read:[`${model}.read`]}]))};
  const definitions = Object.fromEntries(Object.entries(fields).map(([model,modelFields])=>[model,{fields:modelFields,
    readGrants:[{rule:`${model}.read`,by:['members'],fields:Object.keys(modelFields)}]}]));
  const contracts = {
    [`${APP}.Nested`]:{fields:{location:{type:LOCATION}}},
    [`${APP}.Request`]:{fields:{customer:{type:CUSTOMER},nested:{type:`${APP}.Nested`},customers:{type:CUSTOMER,array:true},
      title:{type:'text'},value:{type:'money'},count:{type:'int'}}},
  };
  const js = `import {create,require as requireCondition} from '@canlang/stdlib';
let executions=0,captured;
export const inspect=()=>({executions,captured});
export const appDefinition={id:'${APP}',policy:${JSON.stringify(policy)},models:${JSON.stringify(definitions)},contracts:${JSON.stringify(contracts)},
 operations:{'${OP}':{handler:'${OP}',by:'members',inputs:{request:{type:'${APP}.Request'},location:{type:'${LOCATION}'},swap:{type:'bool'},accept:{type:'bool'}},result:{type:'void'}}}};
export function canApp(){return {policy:${JSON.stringify(policy)},operations:${JSON.stringify(operations)},
 read:Object.fromEntries(${JSON.stringify(Object.keys(fields))}.map(model=>[model+'.read',()=>true])),
 '${APP}':{save:async(c,input)=>{
 executions++;captured=input;
 if(!Object.isFrozen(input.request)||!Object.isFrozen(input.request.nested)||!Object.isFrozen(input.request.customers))throw new Error('mutable Contract');
 if(typeof input.request.count!=='bigint')throw new Error('native int lost');
 const request=input.swap?Object.freeze({...input.request,customer:input.location}):input.request;
 await create(c,'${SNAPSHOT}',{input:request});
 requireCondition(input.accept);
 }}};}`;
  return {artifact_version:1,language_version:'declaration-labelled',tool_version:'consumer-component',
    sources:[{path:SOURCE,sha256:createHash('sha256').update(source).digest('hex')}],
    modules:[{path:MODULE,js,map:{version:3,file:MODULE,sources:[SOURCE],sourcesContent:[source],names:[],mappings:''}}],
    callables:[{id:OP,kind:'operation',module:MODULE,export:'inspect',member:[APP,'save'],inputStyle:'parameters'}],operations,
    models:[
      ...[CUSTOMER,LOCATION].map(name=>({name,deleteMode:'archive' as const,fields:[
        {name:'name',field:{kind:'string' as const},valueType:'text' as CanTypeId,required:true,serverOnly:false},
      ]})),
      {name:SNAPSHOT,deleteMode:'archive',fields:[{name:'input',field:{kind:'nominal',name:`${APP}.Request`},
        valueType:type(`${APP}.Request`),required:true,serverOnly:false}]},
    ],valueTypes:{contracts:[
      {name:`${APP}.Nested`,fields:[{name:'location',type:type(LOCATION)}]},
      {name:`${APP}.Request`,fields:[{name:'customer',type:type(CUSTOMER)},{name:'nested',type:type(`${APP}.Nested`)},
        {name:'customers',type:type(`${CUSTOMER}[]`)},{name:'title',type:'text'},{name:'value',type:'money'},{name:'count',type:'int'}]},
    ]},pages:[],tests:[],requires:[{capability:'canlang.builtins',min_version:2},{capability:'state',min_version:1},{capability:'state.parameters',min_version:1}]};
}

it('component snapshots genuine nested native references and refuses a same-id wrong model before wire erasure',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'can-native-contract-snapshot-'));
  try {
    const artifact=declaration();
    const asm=await assembleModules({artifact,sourcePath:SOURCE},{workDir:directory,stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib')});
    const namespace=await importVerifiedAssemblyModule(asm,MODULE,artifact) as {inspect():{executions:number;captured:unknown}};
    const clock=createFrozenClock(FIXED_NOW),identities=createMemoryIdentityStore({clock});
    const team=await identities.createTeam({});
    const user=await identities.createUser({email:'contract-snapshot@example.test',password_hash:'unused',email_verified:true});
    await identities.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:false,roles:[]});
    const token=randomBytes(32).toString('hex');
    await identities.createSession({user_id:user.user_id,token_sha256:await sha256HexText(token),last_team_id:team.team_id,
      expires_at:new Date(FIXED_NOW+3600000).toISOString()});
    const identity=await resolveIdentity(identities,{session_token:token},{clock});
    const {store:physical,probe}=createTestMemoryStorage(),batches:CommitBatch[]=[];
    const store:StoragePort={...physical,async commit(batch){const result=await physical.commit(batch);batches.push(batch);return result;}};
    const sharedId=uuidv7(FIXED_NOW,810);
    const customer=await seedRow(store,CUSTOMER,{id:sharedId,data:{name:'private Customer business field'}});
    const location=await seedRow(store,LOCATION,{id:sharedId,data:{name:'private Location business field'}});
    const customerBefore=await store.load(CUSTOMER,customer.id),locationBefore=await store.load(LOCATION,location.id);
    const invoker=buildInvoker(artifact,asm,store,{appId:APP,memberships:identities,now:()=>FIXED_NOW});
    const ref={id:sharedId,version:String(customer.version)};
    assert.equal(location.version,customer.version);
    const request={customer:ref,nested:{location:ref},customers:[ref,ref],title:'reviewed',value:{minor:'500',currency:'EUR'},count:'7'};
    const inputs={request,location:ref,swap:false,accept:true},originalInputs=structuredClone(inputs);
    let sequence=820;
    const envelope=(values:MutationEnvelope['inputs']):MutationEnvelope=>({operation:OP,operation_id:uuidv7(FIXED_NOW,++sequence),inputs:values});
    const receiptIdentity=(call:MutationEnvelope):ReceiptIdentity=>({app:APP,owner:team.team_id,principal:user.user_id,
      operation:OP as ReceiptIdentity['operation'],operationId:call.operation_id as ReceiptIdentity['operationId']});
    const invoke=(call:MutationEnvelope)=>invoker.invokeMutation(call,identity);
    const snapshots=()=>store.query({model:SNAPSHOT,authority:'owner'});
    const positive=envelope(inputs),before=await snapshots(),count=batches.length;
    const result=await invoke(positive);assert.ok('result' in result,JSON.stringify(result));assert.equal(result.result.status,'committed');
    const saved=await snapshots();assert.equal(saved.length,before.length+1);
    assert.deepEqual(saved[0]!.data.input,request);
    const snapshot=JSON.stringify(saved[0]!.data.input);
    assert.ok(!snapshot.includes('business field'));assert.ok(!snapshot.includes('"name"'));
    assert.equal(batches.length,count+1);assert.equal(batches.at(-1)!.writes.length,1);assert.equal(batches.at(-1)!.history.length,1);
    assert.deepEqual(batches.at(-1)!.outbox,[]);assert.deepEqual(batches.at(-1)!.schedules,[]);
    assert.deepEqual(inputs,originalInputs);assert.equal(namespace.inspect().executions,1);
    const positiveReceipt=await store.readReceipt(receiptIdentity(positive));assert.ok(positiveReceipt);
    assert.equal(positiveReceipt.outcome.status,'committed');assert.equal(Object.hasOwn(positiveReceipt.outcome,'scenario'),false);
    // This component supplies no invented compiler disclosure plan. Legacy
    // committed recovery stays withheld and must never execute or write again.
    const recovered=await invoke(positive);assert.ok('error' in recovered);assert.equal(recovered.error.code,'validation');
    assert.match(recovered.error.message,/no supported execution association/);
    assert.equal(namespace.inspect().executions,1);assert.equal(batches.length,count+1);assert.deepEqual(await snapshots(),saved);
    assert.deepEqual(await store.readReceipt(receiptIdentity(positive)),positiveReceipt);
    for(const [values,code,message] of [
      [{...inputs,swap:true},'validation',/Native reference requires its exact declared model/],
      [{...inputs,accept:false},'rule_failed',/forbidden/],
    ] as const){
      const call=envelope(values),rowsBefore=await snapshots(),batchCount=batches.length;
      const rejected=await invoke(call);assert.ok('error' in rejected,JSON.stringify(rejected));assert.equal(rejected.error.code,code);
      assert.match(rejected.error.message,message);assert.deepEqual(await snapshots(),rowsBefore);
      assert.equal(batches.length,batchCount+1);const batch=batches.at(-1)!;
      assert.deepEqual(batch.writes,[]);assert.deepEqual(batch.history,[]);assert.deepEqual(batch.outbox,[]);assert.deepEqual(batch.schedules,[]);
      const receipt=await store.readReceipt(receiptIdentity(call));assert.ok(receipt);assert.equal(receipt.outcome.status,'rejected');
      const executions=namespace.inspect().executions;
      const replay=await invoke(call);assert.ok('error' in replay);assert.equal(replay.error.code,code);assert.match(replay.error.message,message);
      assert.equal(namespace.inspect().executions,executions);assert.equal(batches.length,batchCount+1);
      assert.deepEqual(await store.readReceipt(receiptIdentity(call)),receipt);assert.deepEqual(await snapshots(),rowsBefore);
    }
    assert.deepEqual(await store.load(CUSTOMER,customer.id),customerBefore);assert.deepEqual(await store.load(LOCATION,location.id),locationBefore);
    assert.deepEqual(probe.historyFor(CUSTOMER,customer.id),[]);assert.deepEqual(probe.historyFor(LOCATION,location.id),[]);
    assert.deepEqual(probe.outboxAll(),[]);assert.deepEqual(await store.schedulesDue(Number.MAX_SAFE_INTEGER,100),[]);
    assert.deepEqual(inputs,originalInputs);
  }finally{await rm(directory,{recursive:true,force:true});}
});
