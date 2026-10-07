
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const base=dirname(new URL(import.meta.url).pathname);
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const m of artifact.modules){const p=resolve(base,m.path);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,m.js);assert(!m.js.includes('\0'),'unescaped marker');}
const entry=await import(pathToFileURL(resolve(base,artifact.modules[0].path)));
const registry=entry.canApp();
const call=name=>{const item=artifact.callables.find(x=>x.id.endsWith('.'+name));assert(item,name);let fn=registry;for(const p of item.member)fn=fn[p];return fn;};
const context={};
let trace=[];
const row={};
for(const [key,value]of [['a',1n],['b',2n],['c',3n]])Object.defineProperty(row,key,{get(){trace.push(key);queueMicrotask(()=>trace.push(key+' settled'));return value;}});
assert.equal(await call('awaitOrder')(context,row),6n);
assert.deepEqual(trace,['a','a settled','b','b settled','c','c settled']);
console.log('awaited order/once',JSON.stringify(trace));
trace=[];
const rejected={};Object.defineProperty(rejected,'a',{get(){trace.push('a');throw Error('first operand');}});Object.defineProperty(rejected,'b',{get(){trace.push('b');return 1n;}});
await assert.rejects(call('awaitOrder')(context,rejected),{message:'first operand'});assert.deepEqual(trace,['a']);
let reads=0;const skipped={};Object.defineProperty(skipped,'a',{get(){reads++;throw Error('later operand');}});
await assert.rejects(call('overflow')(context,skipped),{code:'overflow',message:'int64 out of range: 9223372036854775808'});assert.equal(reads,0);
trace=[];const asyncOverflow={};Object.defineProperty(asyncOverflow,'a',{get(){trace.push('a');return 1n;}});Object.defineProperty(asyncOverflow,'b',{get(){trace.push('b');throw Error('too late');}});
await assert.rejects(call('overflowAsync')(context,asyncOverflow),{code:'overflow',message:'int64 out of range: 9223372036854775808'});assert.deepEqual(trace,['a']);
console.log('overflow exact code/message and later operand skipped');
trace=[];const coalesce={maybe:null};Object.defineProperty(coalesce,'a',{get(){trace.push('a');return 9n;}});
assert.equal(await call('coalesce')(context,coalesce),9n);assert.deepEqual(trace,['a']);
coalesce.maybe=0n;trace=[];assert.equal(await call('coalesce')(context,coalesce),0n);assert.deepEqual(trace,[]);
for(const [name,flag]of [['andTaken',false],['orTaken',true]]){trace=[];const r={};Object.defineProperty(r,'flag',{get(){trace.push('flag');return flag;}});assert.equal(await call(name)(context,r),flag);assert.deepEqual(trace,['flag']);}
trace=[];const nested={flag:true};Object.defineProperty(nested,'a',{get(){trace.push('a');throw Error('nested skipped');}});assert.equal(await call('nestedLazy')(context,nested),true);assert.deepEqual(trace,[]);
assert.equal(await call('enumExpected')(context,{s:'draft'}),true);assert.equal(await call('enumExpected')(context,{s:'approved'}),false);
for(const [name,value,expected]of [['narrowAnd',null,false],['narrowAnd',1n,true],['narrowOr',null,true],['narrowOr',-1n,false]])assert.equal(await call(name)(context,{maybe:value}),expected);
assert.equal(await call('textScope')(context,'\0binary-left\0\0binary-right\0','B'),true);
console.log('taken/skipped conditional branches, enum expectation, narrowing, text escaping/scopes passed');
trace=[];const member={};Object.defineProperty(member,'a',{get(){trace.push('left');return 2n;}});Object.defineProperty(member,'items',{get(){trace.push('right');return [2n];}});assert.equal(await call('membership')(context,member),true);assert.deepEqual(trace,['left','right']);
console.log('long membership operand source order',JSON.stringify(trace));
