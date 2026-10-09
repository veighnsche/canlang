import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const [root,artifactPath,scratch] = process.argv.slice(2);
const require = createRequire(resolve(root,'package.json'));
const load = specifier => import(pathToFileURL(require.resolve(specifier)));
const {loadArtifactFile} = await load('@canlang/cloudflare/runtime/artifact');
const {assembleModules} = await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker} = await load('@canlang/cloudflare/worker/assembly');
const {createTestMemoryStorage} = await load('@canlang/state/storage/memory');
const {RECEIPT_ASSOCIATION_MODEL,RECEIPT_MODEL,newAssociationRow,newReceiptRow} = await load('@canlang/state/receipt/tables');
const {encodeValue,makeRecordRef} = await load('@canlang/values');
const {FIXED_NOW,createMemoryIdentityStore,seedMember,makeIdentity,uuidv7} = await load('@canlang/state/testing/invocation/fixtures');

const loaded = loadArtifactFile(artifactPath),artifact = loaded.artifact;
const generated = artifact.modules.map(module=>module.js).join('\n');
assert.equal((generated.match(/field:"notification"},\["error"\]/g)??[]).length,3,'both reads and mutation request the authorized whole error leaf');
assert.ok(!generated.includes('["error.message"]')&&!generated.includes('["error.code"]'),'no native selector extension');
const assembly = await assembleModules(loaded,{
  workDir:resolve(scratch,'modules'),
  stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
  uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {store} = createTestMemoryStorage(),memberships = createMemoryIdentityStore();
const member = await seedMember(memberships,{isOwner:false});
const identity = makeIdentity({membership:member.membership,email:member.user.email});
const invoker = buildInvoker(artifact,assembly,store,{memberships,now:()=>FIXED_NOW});
const model = 'DeliveryErrorShapes.Entry',source = 'std.EmailV1.send';
const meta = {nowMs:FIXED_NOW,actor:identity.actor.user_id};
const row = (id,notification) => ({id,version:1,created:FIXED_NOW,updated:FIXED_NOW,
  createdBy:meta.actor,updatedBy:meta.actor,archivedAt:null,parent:null,
  data:{label:id,error:'previous error',notification}});
const writes = [];
const cases = [
  ['failed','failed',{code:'safe_failure',message:'Safe explanation'}],
  ['unknown','unknown',null],
  ['diagnostic','unknown',{code:'uncertain',message:'Awaiting confirmation'}],
  ['pending','pending',null],
  ['skipped','skipped',null],
];
for (const [id,status,error] of cases) {
  const deliveryId = `delivery-${id}`;
  writes.push({kind:'insert',model,row:row(id,{id:deliveryId,operation:source})},
    {kind:'insert',model:RECEIPT_ASSOCIATION_MODEL,row:newAssociationRow({recordModel:model,recordId:id,
      field:'notification',deliveryId,source,revision:1},meta)},
    {kind:'insert',model:RECEIPT_MODEL,row:newReceiptRow({deliveryId,revision:1,status,
      result:null,error,contentRef:null,resultExpiresAtMs:null},meta)});
}
writes.push({kind:'insert',model,row:row('absent',null)});
await store.commit({expectedRevision:await store.readRevision(),writes,history:[],receipt:null,
  outbox:[],schedules:[],uniqueClaims:[],uniqueReleases:[]});

const reference = (id,version) => encodeValue(model,makeRecordRef(model,id,version));
for (const [id,,error] of [...cases,['absent',null,null]]) {
  for (const [operation,key] of [['read_code','code'],['read_message','message']]) {
    const result = await invoker.invokeRead({operation:`DeliveryErrorShapes.${operation}`,inputs:{entry:reference(id)}},identity);
    assert.ok('result' in result,JSON.stringify(result));
    assert.equal(result.result.result,error?.[key]??null,`${id}.${key}: actual generated read → canonical receipt join`);
  }
}
const receiptRead = (selected,caller=identity) => invoker.invokeRead({operation:'Receipt.read',
  inputs:{recordId:'failed',field:'notification',selected}},caller);
const direct = await receiptRead(['error']);
assert.equal(direct.result.outcome,'observed');
assert.deepEqual(direct.result.projection,{error:cases[0][2]},'native projection includes exactly the granted leaf');
const denied = await receiptRead(['result']);
assert.equal(denied.result.outcome,'denied');
assert.deepEqual(denied.result.denied,['result'],'error grant does not extend to result');
const wrongSelector = await receiptRead(['error.message']);
assert.equal(wrongSelector.error.code,'validation','native receipt selectors remain closed');
const anonymous = makeIdentity({actor:null,team:identity.team,membership:null});
const hidden = await receiptRead(['error'],anonymous);
assert.equal(hidden.error.code,'not_found','ungranted owner remains hidden');

let sequence = 0;
for (const [id,,failure] of cases.slice(0,2)) {
  const current = await store.load(model,id);
  const result = await invoker.invokeMutation({operation:'DeliveryErrorShapes.capture',
    operation_id:uuidv7(FIXED_NOW,++sequence),inputs:{entry:reference(id,BigInt(current.version))}},identity);
  assert.ok('result' in result,JSON.stringify(result));
  assert.equal(result.result.status,'committed');
  assert.equal((await store.load(model,id)).data.error,failure?.message??null,
    'native nullable member set explicitly replaces the previous value with null');
}
console.log('generated delivery error reads: installed canonical receipt join, closed selectors, code/message/null, denied access and native nullable set passed; completion trigger remains unsupported');
