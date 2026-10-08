import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {action,invocation,makeRecordRef,parseDecimal} from '@canlang/values';
import {action as publicAction} from '@canlang/stdlib';
assert.equal(action,publicAction);
const artifact=JSON.parse(readFileSync('artifact.json','utf8'));
const base=resolve('generated');
for(const module of artifact.modules){const file=resolve(base,module.path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,module.js);}
const entry=await import(pathToFileURL(resolve(base,artifact.modules.find(m=>m.js.includes('function canApp')).path)));
const registry=entry.canApp();
const context={memberships:['members'],actor:{id:'actor'}};
const call=(name,...args)=>{const item=artifact.callables.find(i=>i.id===`Targets.${name}`);assert(item,name);let fn=registry;for(const key of item.member)fn=fn[key];return fn(context,...args);};
const record=makeRecordRef('Targets.Item','w1',7n);
let reads=0;
const result=await call('descriptors',{get record(){reads++;return record;}});
assert.equal(reads,1,'caller input must be read once');
for(const [key,target] of [['local','Targets.mutate']]){
 const reference=result[key];assert.equal(reference.kind,'action');assert.equal(reference.target,target);assert(Object.isFrozen(reference));assert(Object.isFrozen(reference.bindings));
 assert(artifact.operations.some(op=>op.name===target),`canonical target ${target} must name the owning operation`);
 if(key==='create')assert.deepEqual(reference.bindings,{});else {assert.equal(reference.bindings.record.model,'Targets.Item');assert.equal(reference.bindings.record.id,'w1');assert.equal(reference.bindings.record.version,7n);assert(Object.isFrozen(reference.bindings.record));}
}
assert.deepEqual(await call('defaults',{}),action('Targets.empty',{}));
// The native constructor boundary requires versioned RecordRefs. This does
// not claim store hydration or worker execution from a stored-record value.
await assert.rejects(()=>call('descriptors',{record:makeRecordRef('Targets.Item','w1')}),/expected version/);
await assert.rejects(()=>call('descriptors',{record:{id:'w1',title:'stored row'}}),/record ref/);
const nativeInvocation=invocation('Targets.mutate',{record:makeRecordRef('Targets.Item','w1'),amount:parseDecimal('2.50')});
assert(Object.isFrozen(nativeInvocation));assert.equal(nativeInvocation.args.record.version,undefined);assert.equal(nativeInvocation.args.amount.coef,250n);
console.log('Action target data: canonical local identities, named slots, record versions and empty bindings executed through installed public owners; no target mutation invoked. Invocation native owner control passed; generated invocation blocked by missing stdlib export. Stored-record hydration and worker admission remain unqualified.');
