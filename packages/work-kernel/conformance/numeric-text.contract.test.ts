import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {observeNumber} from './numeric-text.oracle.mjs';
import * as rows from '../src/rows.js';
import * as receipt from '../src/receipt.js';
import * as linkage from '../src/linkage.js';
import * as recovery from '../src/recovery.js';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/numeric-text.json',import.meta.url),'utf8'));
function thaw(x:any):any {if(x?.$bits){const v=new DataView(new ArrayBuffer(8));v.setBigUint64(0,BigInt('0x'+x.$bits));return v.getFloat64(0)}if(x?.$entries)return Object.fromEntries(x.$entries.map(([k,v]:any)=>[k,thaw(v)]));if(Array.isArray(x))return x.map(thaw);return x}
function bits(n:number){const v=new DataView(new ArrayBuffer(8));v.setFloat64(0,n);return v.getBigUint64(0).toString(16).padStart(16,'0')}
function observe(x:any):any {if(typeof x==='number')return {$bits:bits(x)};if(x===undefined)return {$undefined:true};if(Array.isArray(x))return x.map(observe);if(x&&typeof x==='object')return {$entries:Object.entries(x).map(([k,v])=>[k,observe(v)])};return x}
function error(e:any){return {name:e.name,message:e.message,codePresent:'code' in e,code:observe(e.code),detailsPresent:'details' in e,details:observe(e.details),ownKeys:Object.keys(e)}}
function compareNumber(actual:any,expected:any){assert.equal(actual.stringText,expected.stringText);assert.equal(actual.jsonTokenText,expected.jsonTokenText);if(!Number.isNaN(thaw({$bits:expected.inputBits})))assert.equal(actual.observedBits,expected.observedBits)}
function observeCaller(c:any):any {const modules:any={rows,receipt,linkage,recovery};const args=thaw(c.args);if(c.leaf==='rows')args.push(c.direction);try{return {ok:observe(modules[c.leaf][c.fn](...args))}}catch(e){return {throw:error(e)}}}
function compareCaller(actual:any,expected:any){assert.deepEqual(actual,expected)}
test('immutable primitive builtin observations',()=>{assert.equal(fixture.numbers.length,10213);for(const c of fixture.numbers)compareNumber(observeNumber(c.inputBits),c)});
for(const c of fixture.callers)test(c.leaf+'/'+c.id+'/'+(c.direction??''),()=>{compareCaller(observeCaller(c),c.expected)});
test('negative controls reject numeric and envelope mutations',()=>{
 const texts=new Map(fixture.numbers.map((x:any)=>[x.inputBits,x]));
 for(const [bits,bad,channel] of [['4415af1d78b58c40','9223372036854775807','stringText'],['c415af1d78b58c40','-9223372036854775808','stringText'],['8000000000000000','-0','stringText'],['7ff0000000000000','Infinity','jsonTokenText'],['7ff8000000000000','NaN','jsonTokenText']] as const){const c:any=texts.get(bits);assert.ok(c);assert.throws(()=>compareNumber({...observeNumber(bits),[channel]:bad},c),assert.AssertionError)}
 const exponential:any=fixture.numbers.find((x:any)=>x.stringText==='1e+21');assert.ok(exponential);for(const bad of ['1e21','1000000000000000000000'])assert.throws(()=>compareNumber({...observeNumber(exponential.inputBits),stringText:bad},exponential),assert.AssertionError);
 const c=fixture.numbers.find((x:any)=>x.inputBits==='3ff0000000000000');assert.throws(()=>compareNumber(observeNumber('3ff0000000000001'),c),assert.AssertionError);
 const caller=fixture.callers.find((x:any)=>x.expected.throw?.codePresent);const e=observeCaller(caller).throw;
 for(const changed of [{...e,code:'wrong'},{...e,ownKeys:[...e.ownKeys].reverse()},{...e,message:e.message+'!'}])assert.throws(()=>compareCaller({throw:changed},caller.expected),assert.AssertionError);
 const stateCaller=fixture.callers.find((x:any)=>x.expected.throw?.name==='StateError');const state=observeCaller(stateCaller).throw;
 for(const key of ['retryable','fields','conflict']){
  assert.throws(()=>compareCaller({throw:{...state,ownKeys:state.ownKeys.filter((k:string)=>k!==key)}},stateCaller.expected),assert.AssertionError);
  assert.throws(()=>compareCaller({throw:{...state,ownKeys:state.ownKeys.map((k:string)=>k===key?key+'!':k)}},stateCaller.expected),assert.AssertionError);
 }
 assert.throws(()=>compareCaller({throw:{...state,ownKeys:[...state.ownKeys].reverse()}},stateCaller.expected),assert.AssertionError);
});
