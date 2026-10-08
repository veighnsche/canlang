import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import * as ui from '@canlang/ui';
import * as values from '@canlang/values';
import {queryRecords} from '@canlang/state';
import {buildPolicyTable} from '@canlang/state/policy/grants';
import {createMemoryStorage} from '@canlang/state/storage/memory';

const here=path.dirname(fileURLToPath(import.meta.url));
const packet=path.dirname(here);
const root=path.resolve(packet,'../../..');
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files=new Set([path.join(root,'compiler/src/codegen/js.rs'),path.join(root,'packages/values/dist/catalog.json')]);
const frozenBinary='/private/tmp/can-compiler-0134ebb0-page-handoff/can';
assert.equal(hash(frozenBinary),'b2608559e9af0e934a0727faad1d31aee43528cb87a9359f3576a6d8b3db3a7e');files.add(frozenBinary);
for(const file of ['docs/research/compiler-library-audit-20261006/responsibility-map/semantics.md','docs/research/compiler-library-audit-20261006/resumption/lowering-and-execution.md'])files.add(path.join(root,file));
for(const pkg of ['ui','values','stdlib','contracts','state']){
  files.add(path.join(root,'packages',pkg,'package.json'));
  for(const sub of ['src','dist']){
    const walk=dir=>{for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())walk(file);else if(item.isFile())files.add(file);}};
    walk(path.join(root,'packages',pkg,sub));
  }
}
const generatedIds=['date0001','date0099','date2001','date2024','instant','decimal','integer','ordinal'];
const baseline=JSON.parse(fs.readFileSync(path.join(packet,'outcomes.json'),'utf8'));
for(const id of generatedIds){const row=baseline.observations.find(row=>row.id===id);assert.equal(row.exit,0);assert.equal(row.sourceHash,hash(path.join(packet,id+'.can')));assert.equal(row.artifactHash,hash(path.join(packet,id+'.stdout')));}
for(const id of [...generatedIds,'model-wire']){
  files.add(path.join(packet,id+'.can'));files.add(path.join(packet,id+'.stdout'));
  const artifact=JSON.parse(fs.readFileSync(path.join(packet,id+'.stdout'),'utf8'));
  for(const module of artifact.modules)files.add(path.join(packet,id==='model-wire'?'model-wire-generated':id,module.path));
}
const pin=()=>Object.fromEntries([...files].sort().map(file=>[path.relative(root,file),hash(file)]));
const before=pin();
const context=Object.freeze({preferredLocales:[],appDefaultLocale:'en'});
const capture=async fn=>{try{return {ok:true,value:await fn()};}catch(error){return {ok:false,name:error.name,code:error.code,message:error.message};}};

// Original tests are byte-preserved apart from the two added cases.
const originalTests=execFileSync('git',['show','HEAD:packages/ui/test/messages.test.ts'],{cwd:root,encoding:'utf8'});
const currentTests=fs.readFileSync(path.join(root,'packages/ui/test/messages.test.ts'),'utf8');
const additionStart=currentTests.indexOf('  it("preserves full civil years for date and datetime operands",');
const additionEnd=currentTests.indexOf('  it("keeps quoted',additionStart);
assert.notEqual(additionStart,-1);assert.notEqual(additionEnd,-1);
assert.equal(currentTests.slice(0,additionStart)+currentTests.slice(additionEnd),originalTests);
const priorReceipt=JSON.parse(fs.readFileSync(path.join(packet,'receipt.json'),'utf8'));
for(const file of ['packages/ui/src/messages.ts','packages/ui/test/messages.test.ts','packages/ui/dist/src/messages.js','packages/ui/dist/test/messages.test.js'])assert.equal(hash(path.join(root,file)),priorReceipt.pins[file].after);
const reusedTestOutput=fs.readFileSync(path.join(packet,'ui-test.stdout'),'utf8');
assert.match(reusedTestOutput,/tests 28/);assert.match(reusedTestOutput,/pass 28/);assert.match(reusedTestOutput,/fail 0/);assert.equal(fs.readFileSync(path.join(packet,'ui-test.stderr'),'utf8'),'');
const reusedUiTests={command:priorReceipt.ui.test,exit:priorReceipt.ui.testExit,passed:28,originalCount:26,addedCount:2,producerHashesMatch:true,stdoutHash:hash(path.join(packet,'ui-test.stdout')),stderrHash:hash(path.join(packet,'ui-test.stderr'))};

const calendar=[];
const valid=[['0001-01-01','Jan 1, 1'],['0099-01-01','Jan 1, 99'],['0100-01-01','Jan 1, 100'],['0004-02-29','Feb 29, 4'],['0400-02-29','Feb 29, 400'],['1900-02-28','Feb 28, 1900'],['2000-02-29','Feb 29, 2000'],['9999-12-31','Dec 31, 9999']];
for(const [day,expected] of valid){
  for(const type of ['date','datetime']){
    const value=type==='date'?day:`${day}T00:00:00.000Z`;
    const descriptor=ui.message('{x,date}',{},{x:{type,value}});
    const direct=ui.formatMessage(descriptor,{locale:'en',timeZone:'UTC'});
    const caption=ui.resolveCaption(descriptor,context);
    const text=await ui.text({context,values:[descriptor]});
    const scalar=ui.formatScalar({type,value},{locale:'en',timeZone:'UTC'});
    assert.equal(direct,expected);assert.equal(caption,expected);assert.equal(text,`<p>\u2068${expected}\u2069</p>`);
    assert.equal(scalar,type==='date'?expected:`${expected}, 12:00:00 AM`);
    calendar.push({day,type,direct,caption,text,scalar});
  }
}
for(const day of ['0000-01-01','0001-02-29','0099-02-29','0100-02-29','1900-02-29','0004-02-30','2000-02-30','2024-04-31','2024-00-01','2024-13-01','2024-01-00','2024-01-32','10000-01-01']){
  for(const type of ['date','datetime']){
    const value=type==='date'?day:`${day}T00:00:00.000Z`;
    const descriptor=ui.message('{x,date}',{},{x:{type,value}});
    const direct=await capture(()=>ui.formatMessage(descriptor,{locale:'en',timeZone:'UTC'}));
    const text=await capture(()=>ui.text({context,values:[descriptor]}));
    const scalar=await capture(()=>ui.formatScalar({type,value},{locale:'en',timeZone:'UTC'}));
    const message=type==='date'?'type date needs a valid YYYY-MM-DD civil date':'type datetime needs a canonical RFC3339 UTC instant';
    for(const result of [direct,text])assert.deepEqual(result,{ok:false,name:'TypeError',code:undefined,message:`message argument "x": ${message}`});
    assert.deepEqual(scalar,{ok:false,name:'TypeError',code:undefined,message:`message argument "value": ${message}`});
    calendar.push({day,type,direct,text,scalar});
  }
}
const inheritance=[];
for(const value of ['0001-01-01T00:00:00.000Z','0099-01-01T23:59:59.999Z','0004-02-29T12:34:56.000Z']){
  const actual=ui.formatMessage('{x,time}',{locale:'en',timeZone:'UTC',args:{x:{type:'datetime',value}}});
  const expected=value.includes('T00:')?'12:00:00 AM':value.includes('T23:')?'11:59:59 PM':'12:34:56 PM';
  assert.equal(actual,expected);inheritance.push({value,actual,expected});
}
for(const value of ['0004-02-29T24:00:00.000Z','0004-02-29T00:60:00.000Z','0004-02-29T00:00:60.000Z','0004-02-29T00:00:00+00:00']){
  const result=await capture(()=>ui.formatMessage('{x,time}',{locale:'en',args:{x:{type:'datetime',value}}}));
  assert.equal(result.name,'TypeError');inheritance.push({value,result});
}
const dateTimeRefusal=await capture(()=>ui.formatMessage('{x,time}',{locale:'en',args:{x:{type:'date',value:'0001-01-01'}}}));
assert.equal(dateTimeRefusal.ok,false);inheritance.push({dateTimeRefusal});

const stdlib=await import('@canlang/stdlib');
for(const name of ['encodeValue','decodeValue','isDateValue','isDatetime','isDecimal'])assert.equal(stdlib[name],values[name]);
const codecs=[];
for(const [type,native,wire,pattern,expected] of [
  ['date',values.date('0001-01-01'),'0001-01-01','{x,date}','Jan 1, 1'],
  ['date',values.date('0099-01-01'),'0099-01-01','{x,date}','Jan 1, 99'],
  ['datetime',values.datetime('2024-04-01T00:30:00+02:00'),'2024-03-31T22:30:00.000Z','{x,time}','10:30:00 PM'],
  ['decimal',new values.Decimal(12345678901234567890123456789012345678n,18),'12345678901234567890.123456789012345678','{x,number}','12,345,678,901,234,567,890.123456789012345678'],
]){
  const guard=type==='date'?values.isDateValue:type==='datetime'?values.isDatetime:values.isDecimal;
  assert.equal(guard(native),true);assert.equal(guard(wire),false);
  assert.equal(values.encodeValue(type,native),wire);
  assert.deepEqual(values.decodeValue(type,wire),native);
  const descriptor=ui.message(pattern,{},{x:{type,value:native}});assert.equal(descriptor.params.x.value,native);
  const nativeSink=await capture(()=>ui.text({context,values:[descriptor]}));assert.equal(nativeSink.name,'TypeError');
  const encodedText=await ui.text({context,values:[ui.message(pattern,{},{x:{type,value:wire}})]});assert.equal(encodedText,`<p>\u2068${expected}\u2069</p>`);
  const wireAsNative=await capture(()=>values.encodeValue(type,wire));assert.equal(wireAsNative.code,'invalid-construction');
  codecs.push({type,wire,nativeGuard:true,wireGuard:false,nativeSink,encodedText,wireAsNative});
}
// Datetime's public guard checks carrier shape; the public codec owns supported range.
const outsideRange={kind:'datetime',ms:253402300800000n};
assert.equal(values.isDatetime(outsideRange),true);
const outsideRangeRefusal=await capture(()=>values.encodeValue('datetime',outsideRange));assert.equal(outsideRangeRefusal.code,'invalid-construction');
codecs.push({datetimeGuardNeedsCodecRange:true,outsideRangeRefusal});

// Verify existing emitted module bytes before importing; never edit emitted code.
async function generatedPage(id,dir=id){
  const artifact=JSON.parse(fs.readFileSync(path.join(packet,id+'.stdout'),'utf8'));
  for(const module of artifact.modules){const file=path.join(packet,dir,module.path);assert.equal(fs.readFileSync(file,'utf8'),module.js);files.add(file);}
  const ref=artifact.pages[0];const entry=await import(pathToFileURL(path.join(packet,dir,ref.module)).href);
  const page=entry[ref.export];assert.equal(page,entry.appDefinition.pages[0]);return {page,ref};
}
const nativeGenerated=[];
for(const id of generatedIds){
  const {page,ref}=await generatedPage(id);
  const bindings=await page.admit(context);assert.deepEqual(bindings,{});
  const render=await capture(()=>page.render(context,bindings));
  if(id==='integer'||id==='ordinal')assert.deepEqual(render,{ok:true,value:`<p>\u2068${id==='integer'?'2':'two'}\u2069</p>`});
  else {assert.equal(render.ok,false);assert.equal(render.name,'TypeError');}
  nativeGenerated.push({id,ref,bindings,render});
}

// Existing source model-members read actual State projection unchanged, then actual UI list.
const {page:wirePage,ref:wireRef}=await generatedPage('model-wire','model-wire-generated');
const wireQuery=[];
for(const data of [{day:'2001-01-01',instant:'2024-03-31T22:30:00.000Z',amount:'1.50'},{day:'0004-02-29',instant:'0099-01-01T23:59:59.999Z',amount:'12345678901234567890.123456789012345678'}]){
  const model='TemporalWire.Item';const store=createMemoryStorage();
  const row={id:'review-row',version:1,created:0,updated:0,createdBy:'actor',updatedBy:'actor',archivedAt:null,parent:null,data};
  await store.commit({expectedRevision:await store.readRevision(),writes:[{kind:'insert',model,row}],history:[],receipt:null,outbox:[],schedules:[],uniqueClaims:[],uniqueReleases:[]});
  const policy=buildPolicyTable([{model,secretFields:[],grants:[{by:'members',fields:['day','instant','amount']}]}]);
  const memberships={async findMembership(teamId,userId){return {team_id:teamId,user_id:userId,status:'active',is_owner:false,roles:[]};}};
  const invocation={actorUserId:'actor',teamId:'team'};const queries=[];
  const queryContext={...context,invocation,async query(actualInvocation,actualModel,args){
    assert.equal(actualInvocation,invocation);assert.equal(actualModel,model);
    const result=await queryRecords({policy,model,authority:'viewer',context:invocation,memberships,store});
    assert.equal(result.records.length,1);assert.deepEqual(result.records[0].data,data);queries.push({actualModel,args,data:result.records[0].data});
    return {rows:result.records.map(record=>({id:record.id,version:String(record.version),fields:record.data})),columns:[]};
  }};
  const bindings=await wirePage.admit(queryContext);assert.deepEqual(bindings,{});
  const rendered=await wirePage.render(queryContext,bindings);
  const expected=data.day==='2001-01-01'?'<ul class="list"><li class="list-row"><p>\u2068Jan 1, 2001\u2069 \u206810:30:00 PM\u2069 \u20681.5\u2069</p></li></ul>':'<ul class="list"><li class="list-row"><p>\u2068Feb 29, 4\u2069 \u206811:59:59 PM\u2069 \u206812,345,678,901,234,567,890.123456789012345678\u2069</p></li></ul>';
  assert.equal(rendered,expected);
  const universalEncoding=[];
  for(const [type,key]of [['date','day'],['datetime','instant'],['decimal','amount']]){
    const result=await capture(()=>values.encodeValue(type,data[key]));assert.equal(result.code,'invalid-construction');universalEncoding.push({type,result});
  }
  wireQuery.push({ref:wireRef,queries,rendered,universalEncoding});
}
const after=pin();
const changes=Object.keys(before).filter(key=>before[key]!==after[key]);assert.deepEqual(changes,[]);
const output={scope:'Independent existing public UI sink/full-year leaf and unchanged emitted native plus State wire query witnesses. Explicit public contexts; no canonical dispatcher or deployment claim.',node:process.version,versions:process.versions,originalTestsPreserved:true,reusedUiTests,calendar,inheritance,codecs,nativeGenerated,wireQuery,changes};
fs.writeFileSync(path.join(here,'pins.json'),JSON.stringify({before,after,newGeneratedInputs:Object.keys(after).filter(key=>!Object.hasOwn(before,key)),changes},null,2)+'\n');
fs.writeFileSync(path.join(here,'outcomes.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({originalTestsPreserved:true,calendarCases:calendar.length,inheritanceCases:inheritance.length,nativeGenerated,wireQuery,changes},null,2));
