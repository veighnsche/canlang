// Root independent public installed consumer check, no implementer oracle.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync,realpathSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join,resolve } from 'node:path';
const root=resolve(process.env.CAN_STEP9_VALUES_CONSUMER);
const req=createRequire(join(root,'package.json'));
const loaded={};
async function pub(name){const path=req.resolve(name);assert.ok(realpathSync(path).startsWith(root+'/node_modules/'));loaded[name]={path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};return import(pathToFileURL(path).href);}
const {tsBackend}=await pub('@canlang/values/bindings/backend');
const {bootstrapWasm,BootstrapError}=await pub('@canlang/values/bindings/bootstrap');
const {exact_call}=await pub('@canlang/values/bindings/generated/values_semantics.js');
const {Decimal,ValueError,makeMoney,makeDate}=await pub('@canlang/values');
const ts=tsBackend();
for(const op of ['foreign-op','toString','constructor','__proto__','valueOf','hasOwnProperty']){
 let touched=0;const args=[];Object.defineProperty(args,0,{get(){touched++;throw new Error('foreign operation touched args');}});
 assert.throws(()=>ts.call(op,args),e=>e instanceof ValueError && e.code==='invalid-construction' && e.message==='smoke backend has no op: '+op,op+' refusal');
 assert.equal(touched,0,op+' argument effects');
}
assert.equal(ts.call('add-int',[20n,22n]),42n);
assert.throws(()=>bootstrapWasm(new Uint8Array([0,1,2,3])),e=>e instanceof BootstrapError && e.code==='init-failed');
assert.equal(ts.call('add-int',[20n,22n]),42n,'TS remains usable after rejected Wasm startup, no automatic retry/selection');
const binary=req.resolve('@canlang/values/bindings/generated/values_semantics_bg.wasm');
loaded.wasm={path:binary,sha256:createHash('sha256').update(readFileSync(binary)).digest('hex')};
const wasm=bootstrapWasm(new Uint8Array(readFileSync(binary)));
const numericWitnesses=[8.01033661867104e+241,2.2250738585072014e-308,5e-324,1.7976931348623157e308,1.0000000000000002,-1.0000000000000002,1000000000000000100,1e-7,1e21,-8.01033661867104e+241];
for(const value of numericWitnesses){const response=JSON.parse(exact_call(JSON.stringify({v:1,op:'decode-value',args:[{t:'str',v:'int'},{t:'num',v:value}]})));assert.equal(response.ok,false);assert.equal(response.violations[0].actual,'number '+String(value),'actual JSON input to Rust numeric formatter');}
const vectors=[
 ['add-int',[20n,22n],42n],
 ['negate-int',[42n],-42n],
 ['add-decimal',[new Decimal(15n,1),2n],new Decimal(35n,1)],
 ['negate-decimal',[new Decimal(15n,1)],new Decimal(-15n,1)],
 ['date-to-epoch-days',[makeDate(2024,2,29)],19782],
 ['add-money',[makeMoney(100n,'USD'),makeMoney(25n,'USD')],makeMoney(125n,'USD')]
];
for(const[op,args,expected]of vectors){const a=ts.call(op,args),b=wasm.call(op,args);assert.deepEqual(a,expected);assert.deepEqual(b,expected);if(op.includes('decimal')){assert.ok(b instanceof Decimal);assert.ok(Object.isFrozen(b));}if(op==='add-money')assert.ok(Object.isFrozen(b));}
const observed=[];
for(const[op,args]of [['add-int',[9223372036854775807n,1n]],['negate-int',[-9223372036854775808n]],['add-money',[makeMoney(100n,'USD'),makeMoney(25n,'EUR')]]]){
 const fault=backend=>{try{backend.call(op,args);throw new Error('accepted deliberate invalid witness');}catch(e){assert.ok(e instanceof ValueError);return{name:e.name,code:e.code,message:e.message};}};
 const a=fault(ts),b=fault(wasm);assert.deepEqual(b,a,op+' original error bytes');observed.push({op,error:a});
}
assert.throws(()=>bootstrapWasm(new Uint8Array([0,97,115,109,1,0,0,0])),e=>e instanceof BootstrapError && e.code==='init-failed');
assert.equal(wasm.call('add-int',[40n,2n]),42n);
assert.equal(ts.call('add-int',[40n,2n]),42n);
const receipt={scope:'Root independent six-operation opt-in installed values profile only',node:process.version,checks:{own_name_refusal:6,zero_argument_effects:6,fixed_expected_operation_outcomes:6,error_byte_pairs:observed,raw_transport_numeric_witnesses:numericWitnesses.length,explicit_ts_after_failed_bootstrap:true,pinned_asset_change_refusal:true},loaded,limits:['No full A07.3 registry','No negative-zero scale equivalence claim','No V validation profile producer or durable work consumer','Measurement/default decision not certified','Explicit independent TS use after failed startup is not persisted/profile swap or in-flight drainage rollback']};
if(process.env.CAN_STEP9_RECEIPT)writeFileSync(process.env.CAN_STEP9_RECEIPT,JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({pass:true,checks:receipt.checks,source:loaded}));
