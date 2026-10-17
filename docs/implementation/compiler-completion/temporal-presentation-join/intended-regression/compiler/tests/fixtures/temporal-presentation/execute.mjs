import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {date,datetime,parseDecimal,encodeValue} from '@canlang/values';
import {encodeValue as facadeEncodeValue} from '@canlang/stdlib';
import {resolveCaption} from '@canlang/ui';

assert.equal(facadeEncodeValue,encodeValue);
const artifactPath=resolve(process.argv[2]??'artifact.json');
const artifact=JSON.parse(readFileSync(artifactPath,'utf8'));
const generated=resolve(dirname(artifactPath),'generated');
for(const module of artifact.modules){
  const file=resolve(generated,module.path);
  mkdirSync(dirname(file),{recursive:true});writeFileSync(file,module.js);
}
const context=Object.freeze({preferredLocales:[],appDefaultLocale:'en'});
// Explicit public CaptionContext precondition, not canonical route/app/team provenance.
const pages=[
  ['date0001','Jan 1, 1'],['date0099','Jan 1, 99'],
  ['date2001','Jan 1, 2001'],['date2024','Feb 29, 2024'],
  ['instant','10:30:00 PM'],['offset','8:30:00 PM'],
  ['instant0001','12:00:00 AM'],['instant0099','12:00:00 AM'],
  ['decimal','1.5'],['decimalexact','12,345,678,901,234,567,890.123456789012345678'],
  ['integer','2'],['ordinal','two'],
  ['styles','2/29/04|Feb 29, 4|February 29, 4|Sunday, February 29, 4'],
];
const outcomes=[];
for(const [id,expected] of pages){
  const ref=artifact.pages.find(page=>page.path==='/'+id);assert(ref,id);
  const module=await import(pathToFileURL(resolve(generated,ref.module)).href);
  const descriptor=module[ref.export];
  assert.equal(module.appDefinition.pages.find(page=>page.path===ref.path),descriptor);
  const bindings=await descriptor.admit(context);assert.deepEqual(bindings,{});
  const rendered=await descriptor.render(context,bindings);
  assert.equal(rendered,`<p>\u2068${expected}\u2069</p>`,id);
  outcomes.push({id,admit:bindings,rendered});
}
const entry=await import(pathToFileURL(resolve(generated,artifact.modules[0].path)).href);
const registry=entry.canApp();
const call=(name,ctx,...args)=>{
  const ref=artifact.callables.find(item=>item.id==='TemporalPresentation.'+name);assert(ref,name);
  let fn=registry;for(const member of ref.member)fn=fn[member];return fn(ctx,...args);
};
const day=date('0001-01-01'),instant=datetime('0099-01-01T00:00:00Z');
const amount=parseDecimal('12345678901234567890.123456789012345678');
const values={first:day,later:'L',instant,amount};
function observed(trace,overrides={}){
  const input={};
  for(const key of Object.keys(values))Object.defineProperty(input,key,{configurable:true,get(){
    trace.push(key);return Object.hasOwn(overrides,key)?overrides[key]:values[key];
  }});
  return input;
}
for(const [name,order] of [
  ['direct',['first','later']],['named',['later','first']],['nested',['later','first']],
  ['reserved',['instant','later','first']],
]){
  const trace=[];const descriptor=await call(name,context,observed(trace));
  assert.deepEqual(trace,order,name);
  assert.equal(resolveCaption(descriptor,context),name==='reserved'?'Jan 1, 1|L|12:00 AM':'Jan 1, 1|L');
  const encoded=Object.values(descriptor.params).filter(param=>param.type==='date'||param.type==='datetime');
  for(const param of encoded)assert.equal(typeof param.value,'string');
  outcomes.push({id:name,trace});
}
{
  const trace=[];const ctx={...context,get now(){trace.push('default-now');return instant;}};
  const descriptor=await call('supplied_before_default',ctx,observed(trace));
  assert.deepEqual(trace,['first','later','default-now']);
  assert.equal(resolveCaption(descriptor,context),'Jan 1, 1|12:00 AM|L');
  outcomes.push({id:'supplied-before-default',trace});
}
{
  const trace=[];const ctx={...context,get now(){throw new Error('suppressed-default');}};
  const descriptor=await call('supplied_defaults',ctx,observed(trace));
  assert.deepEqual(trace,['instant','later','first']);
  assert.equal(resolveCaption(descriptor,context),'Jan 1, 1|12:00 AM|L');
}
{
  const trace=[];const ctx={...context,get now(){trace.push('default-now');return instant;}};
  const descriptor=await call('defaulted',ctx);
  assert.deepEqual(trace,['default-now']);
  assert.equal(resolveCaption(descriptor,context),'Jan 1, 1|12:00 AM|D');
}
assert.equal(resolveCaption(await call('dependent_default',context),context),'Jan 1, 1|Jan 1, 1');
{
  const trace=[];const descriptor=await call('override_default',context,observed(trace));
  assert.deepEqual(trace,['first']);assert.equal(descriptor.params.x.value,'0001-01-01');
  assert.equal(descriptor.params.second.value,'0001-01-01');
}
assert.equal((await call('decimal_operand',context,values)).params.x.value,'12345678901234567890.123456789012345678');
assert.equal((await call('datetime_operand',context,values)).params.x.value,'0099-01-01T00:00:00.000Z');
// Invalid native/nonnullable callers fail in the existing public codec at descriptor
// construction, after every supplied expression. They do not reach UI formatting.
for(const name of ['direct','named','nested']){
  for(const bad of [null,'0001-01-01']){
    const trace=[];let descriptorProduced=false;
    await assert.rejects(async()=>{await call(name,context,observed(trace,{first:bad}));descriptorProduced=true;},error=>
      error.name==='ValueError'&&error.code==='invalid-construction'&&error.message===
      (bad===null?'null for non-nullable date at $':'expected a date value at $'));
    assert.equal(descriptorProduced,false);
    assert.deepEqual(trace,name==='direct'?['first','later']:['later','first']);
    outcomes.push({id:name+'-invalid-native',input:bad,trace,stage:'descriptor-codec',name:'ValueError',code:'invalid-construction'});
  }
}
for(const [name,key,type,wire] of [['datetime_operand','instant','datetime','0099-01-01T00:00:00.000Z'],['decimal_operand','amount','decimal','1.5']]){
  for(const bad of [null,wire]){
    await assert.rejects(call(name,context,{...values,[key]:bad}),error=>error.name==='ValueError'&&error.code==='invalid-construction'&&error.message===
      (bad===null?`null for non-nullable ${type} at $`:`expected a ${type} value at $`));
  }
}
{
  const trace=[];await assert.rejects(call('direct',context,observed(trace,{first:null,later:{}})),error=>error.code==='invalid-construction');
  assert.deepEqual(trace,['first','later']);
}
// Argument evaluation itself still short-circuits when an expression throws.
for(const [name,first] of [['direct','first'],['named','later'],['nested','later']]){
  const trace=[];const input=observed(trace);
  Object.defineProperty(input,first,{get(){trace.push(first);throw new Error('operand-body');}});
  await assert.rejects(call(name,context,input),{name:'Error',message:'operand-body'});
  assert.deepEqual(trace,[first]);
}
{
  const trace=[];const input=observed(trace,{first:null});
  Object.defineProperty(input,'later',{get(){trace.push('later');throw new Error('later-body');}});
  await assert.rejects(call('direct',context,input),{name:'Error',message:'later-body'});
  assert.deepEqual(trace,['first','later']);
}
{
  const trace=[];const ctx={...context,get now(){trace.push('default-now');throw new Error('default-body');}};
  await assert.rejects(call('supplied_before_default',ctx,observed(trace,{first:null})),{name:'Error',message:'default-body'});
  assert.deepEqual(trace,['first','later','default-now']);
}
{
  const trace=[];const ctx={...context,get now(){trace.push('default-now');return instant;}};
  await assert.rejects(call('supplied_before_default',ctx,observed(trace,{first:null})),error=>error.name==='ValueError'&&error.code==='invalid-construction');
  assert.deepEqual(trace,['first','later','default-now']);
}
// Constructor errors precede descriptor conversion and later operands.
for(const raw of ['0000-01-01','0099-02-29','2024-02-30']){
  let ownerError;try{date(raw)}catch(error){ownerError=error;}assert(ownerError);
  const trace=[];await assert.rejects(call('construction',context,observed(trace),raw),error=>
    error.name===ownerError.name&&error.code===ownerError.code&&error.message===ownerError.message);
  assert.deepEqual(trace,[]);
}
for(const raw of ['0000-01-01T00:00:00Z','2024-02-30T00:00:00Z']){
  let ownerError;try{datetime(raw)}catch(error){ownerError=error;}assert(ownerError);
  await assert.rejects(call('instant_construction',context,raw),error=>
    error.name===ownerError.name&&error.code===ownerError.code&&error.message===ownerError.message);
}
writeFileSync(resolve(dirname(artifactPath),'outcomes.json'),JSON.stringify(outcomes,null,2)+'\n');
console.log(JSON.stringify({pages:pages.length,checks:'public native codec, exact descriptors, supplied/default/nested order and once, strict native failures, constructor failures',scope:'Explicit CaptionContext only; no selected-app/default authority, team timezone, localized format, State query hydration or browser/deployment qualification.'}));
