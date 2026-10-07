
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const base=dirname(new URL(import.meta.url).pathname);
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const m of artifact.modules){const p=resolve(base,m.path);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,m.js);}
const registry=(await import(pathToFileURL(resolve(base,artifact.modules[0].path)))).canApp();
const call=name=>{const item=artifact.callables.find(x=>x.id.endsWith('.'+name));assert(item,name);let fn=registry;for(const p of item.member)fn=fn[p];return fn;};
for(const value of ['b','s','c','event','result','parent','preferences','count'])assert.equal(await call('allCases')({},value),true);
for(const [value,expected]of [['count',true],['b',false]])assert.equal(await call('expected')({},{v:value}),expected);
for(const [value,expected]of [['b',true],['c',false]])assert.equal(await call('collectionExpected')({},{v:value}),expected);
for(const name of ['bound','boundLong']){
 assert.equal(await call(name)({},'event','event','c'),true);
 assert.equal(await call(name)({},'event','b','event'),false);
}
for(const [value,expected]of [[null,true],['s',true],['event',false]])assert.equal(await call('nullableBound')({},value),expected);
console.log('reserved/fixed/builtin case spellings and dynamic same-spelling enum parameters passed');
for(const name of ['awaited','awaitedGrouped']){
 for(const expected of [true,false]){
  const trace=[];const row={};
  Object.defineProperty(row,'a',{get(){trace.push('left');queueMicrotask(()=>trace.push('left settled'));return 2n;}});
  Object.defineProperty(row,'items',{get(){trace.push('right');queueMicrotask(()=>trace.push('right settled'));return expected?[2n]:[3n];}});
  assert.equal(await call(name)({},row),expected);assert.deepEqual(trace,['left','left settled','right','right settled']);
  console.log(name,expected,JSON.stringify(trace));
 }
 let trace=[];const leftError=Error('left rejected');const left={};Object.defineProperty(left,'a',{get(){trace.push('left');throw leftError;}});Object.defineProperty(left,'items',{get(){trace.push('right');return [2n];}});
 await assert.rejects(call(name)({},left),e=>e===leftError);assert.deepEqual(trace,['left']);
 trace=[];const rightError=Error('right rejected');const right={};Object.defineProperty(right,'a',{get(){trace.push('left');return 2n;}});Object.defineProperty(right,'items',{get(){trace.push('right');throw rightError;}});
 await assert.rejects(call(name)({},right),e=>e===rightError);assert.deepEqual(trace,['left','right']);
}
const skip={maybe:false};for(const key of ['a','items'])Object.defineProperty(skip,key,{get(){throw Error('skipped operand');}});
for(const name of ['orLazy','orLazyLong'])assert.equal(await call(name)({},skip),true);
for(const name of ['nullishLazy','nullishLong'])assert.equal(await call(name)({},skip),false);
for(const name of ['nullishLazy','nullishLong'])assert.equal(await call(name)({},{maybe:null,a:2n,items:[2n]}),true);
console.log('exact awaited failure order; compact/grouped-long or/coalesce lazy skips and taken coalesce passed');
