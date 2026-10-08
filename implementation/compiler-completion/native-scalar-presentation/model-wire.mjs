import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {queryRecords} from '@canlang/state';
import {buildPolicyTable} from '@canlang/state/policy/grants';
import {createMemoryStorage} from '@canlang/state/storage/memory';
import {encodeValue} from '@canlang/values';
const here=dirname(fileURLToPath(import.meta.url));
const retained=resolve(here,'../temporal-presentation-join');
const artifact=JSON.parse(readFileSync(resolve(retained,'model-wire.stdout'),'utf8'));
const generated=resolve(retained,'model-wire-generated');
const ref=artifact.pages[0];
const entry=await import(pathToFileURL(resolve(generated,ref.module)).href);
const descriptor=entry[ref.export];assert.equal(descriptor,entry.appDefinition.pages[0]);
const model='TemporalWire.Item';
const data={day:'2001-01-01',instant:'2024-03-31T22:30:00.000Z',amount:'1.50'};
const store=createMemoryStorage();
const row={id:'row-1',version:1,created:0,updated:0,createdBy:'actor',updatedBy:'actor',archivedAt:null,parent:null,data};
await store.commit({expectedRevision:await store.readRevision(),writes:[{kind:'insert',model,row}],history:[],receipt:null,outbox:[],schedules:[],uniqueClaims:[],uniqueReleases:[]});
const policy=buildPolicyTable([{model,secretFields:[],grants:[{by:'members',fields:['day','instant','amount']}]}]);
const memberships={async findMembership(teamId,userId){return {team_id:teamId,user_id:userId,status:'active',is_owner:false,roles:[]};}};
const invocation={actorUserId:'actor',teamId:'team'};
const queries=[];
const context={preferredLocales:[],appDefaultLocale:'en',invocation,async query(actualInvocation,actualModel,args){
  assert.equal(actualInvocation,invocation);assert.equal(actualModel,model);
  const result=await queryRecords({policy,model,authority:'viewer',context:invocation,memberships,store});
  assert.equal(result.records.length,1);assert.deepEqual(result.records[0].data,data);
  queries.push({model:actualModel,args,data:result.records[0].data,revision:result.revision});
  // Existing UI runner shape only: no native scalar coercion/hydration.
  return {rows:result.records.map(record=>({id:record.id,version:String(record.version),fields:record.data})),columns:[]};
}};
const bindings=await descriptor.admit(context);assert.deepEqual(bindings,{});
const rendered=await descriptor.render(context,bindings);
const expected='<ul class="list"><li class="list-row"><p>\u2068Jan 1, 2001\u2069 \u206810:30:00 PM\u2069 \u20681.5\u2069</p></li></ul>';
assert.equal(rendered,expected);
const strictNativePrerequisite=[];
for(const [type,value]of [['date',data.day],['datetime',data.instant],['decimal',data.amount]]){
  let refusal;try{encodeValue(type,value)}catch(error){refusal={name:error.name,code:error.code,message:error.message};}
  assert.equal(refusal.name,'ValueError');assert.equal(refusal.code,'invalid-construction');
  strictNativePrerequisite.push({type,wire:value,refusal});
}
const output={scope:'Real unchanged generated model-member page, public UI list/query/formatters and public State viewer query with test memory storage. Supplied actor/membership/context proves public contracts only, not canonical dispatcher authority.',queries,rendered,strictNativePrerequisite,prerequisite:'State wire strings remain unchanged and supported by the UI join; strict encodeValue still refuses wire strings as native values.'};
writeFileSync(resolve(here,'model-wire.outcomes.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output));
