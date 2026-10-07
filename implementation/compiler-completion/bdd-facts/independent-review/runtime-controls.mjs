import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {loadExampleSuite} from '@canlang/testkit';
import {lower} from '@canlang/stdlib';
const receipts=[];
const bindings={self:'self',other:'other',imported:null};
async function examples(name){return (await import(`./${name}.test-0.mjs`)).exampleFixtures(bindings).examples;}
async function rejects(name,fn){try{await fn();throw new Error('unexpected success')}catch(error){assert(error instanceof ReferenceError,`${name}: ${error}`);receipts.push({name,outcome:'reproduced',error:{name:error.name,message:error.message,stack:error.stack}})}}
const known=await examples('known');
assert.deepEqual(await known[0].rows[0].values({},{}),['hi']);
assert.deepEqual(await known[0].rows[0].expected({},{}),['hi']);
assert.equal(await known[1].sequence[0].value({}, {}, {}),'hi');
assert.deepEqual(await known[1].sequence[1].inputs({}, {}, {original:'hi'}),{value:'hi'});
assert.deepEqual(await known[1].sequence[6].observations({}, {}, {later:'hi'}),['hi']);
receipts.push({name:'known-call-cells-sequence-let-as',outcome:'passed',qualification:'Exact emitted closures with actual stdlib lower, bindings supplied per callback contract; not full sequence invocation'});
await rejects('known-table-result',()=>known[0].observations[0]({}, {result:'HI'}));
await rejects('known-sequence-result',()=>known[1].sequence[2].observations({}, {result:'hi'}, {saved:'hi',result:'hi'}));
const resultOnly=await examples('result-only');
await rejects('simple-table-result-no-call-expression',()=>resultOnly[0].observations[0]({}, {result:'HI'}));
await rejects('simple-sequence-result-no-call-expression',()=>resultOnly[1].sequence[1].observations({}, {result:'HI'}, {result:'HI'}));
const suite=await loadExampleSuite(new URL('./result-only.test-0.mjs',import.meta.url).href,bindings,{invokeCall:async()=>({ok:true}),observeScope:async()=>({result:'HI'})});
const scope={snapshot:async()=>null,dispose:async()=>{}};
await suite.rows[0].setup(scope);
try{await suite.rows[0].observe(scope);throw new Error('unexpected success')}catch(error){assert.match(error.message,/result is not defined/);receipts.push({name:'real-testkit-result-table',outcome:'reproduced',error:{name:error.name,message:error.message},qualification:'Actual load/setup/observe with generous result-bearing observeScope, invocation port only'})}
const order=(await examples('sequence-order'))[0].sequence[2];
let trace=[];const box={get left(){trace.push('left');return 'A'},get right(){trace.push('right');return 'AB'}};
assert.deepEqual(await order.observations({}, {}, {box}),[true,false]);assert.deepEqual(trace,['left','right']);
trace=[];const bad={get left(){trace.push('left');throw new Error('first')},get right(){trace.push('right');return 'AB'}};
await assert.rejects(order.observations({}, {}, {box:bad}),{message:'first'});assert.deepEqual(trace,['left']);
receipts.push({name:'selected-named-call-source-order-lazy-and-error',outcome:'passed',reads:['left','right'],rejectionReads:['left'],qualification:'Exact emitted sequence assertion, actual stdlib starts_with, getter inputs only; not canonical admission'});
const alias=(await examples('sequence-alias'))[0].sequence[2];
await rejects('imported-helper-alias-undefined-function',()=>alias.observations({}, {}, {word:'A'}));
const ordered=(await examples('ordered-alias'))[0];
await rejects('table-action-input-undefined-value',()=>ordered.observations[0]({}, {value:{left:'A',right:'AB'}}));
writeFileSync(new URL('./runtime-receipts.json',import.meta.url),JSON.stringify(receipts,null,2)+'\n');
console.log(JSON.stringify(receipts.map(({name,outcome,error})=>({name,outcome,error:error?.message})),null,2));
