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
test('immutable primitive builtin observations',()=>{assert.equal(fixture.numbers.length,10213);for(const c of fixture.numbers){const actual=observeNumber(c.inputBits);assert.equal(actual.stringText,c.stringText);assert.equal(actual.jsonTokenText,c.jsonTokenText);if(!Number.isNaN(thaw({$bits:c.inputBits})))assert.equal(actual.observedBits,c.observedBits)}});
for(const c of fixture.callers)test(c.leaf+'/'+c.id+'/'+(c.direction??''),()=>{const modules:any={rows,receipt,linkage,recovery};const args=thaw(c.args);if(c.leaf==='rows')args.push(c.direction);let actual;try{actual={ok:observe(modules[c.leaf][c.fn](...args))}}catch(e){actual={throw:error(e)}}if(actual.throw){const expected=c.expected.throw;const keys=['name','message','code','details'];const mandatory=(x:any)=>({...x,ownKeys:x.ownKeys.filter((k:string)=>keys.includes(k))});assert.deepEqual(mandatory(actual.throw),mandatory(expected));const extras=expected.ownKeys.filter((k:string)=>!keys.includes(k));assert.deepEqual(extras,expected.name==='StateError'?['retryable','fields','conflict']:[])}else assert.deepEqual(actual,c.expected)});
test('negative controls reject numeric and envelope mutations',()=>{
 const texts=new Map(fixture.numbers.map((x:any)=>[x.inputBits,x]));
 for(const [bits,bad,channel] of [['4415af1d78b58c40','9223372036854775807','stringText'],['c415af1d78b58c40','-9223372036854775808','stringText'],['8000000000000000','-0','stringText'],['7ff0000000000000','Infinity','jsonTokenText'],['7ff8000000000000','NaN','jsonTokenText']]){const c:any=texts.get(bits);assert.ok(c);assert.notEqual(c[channel],bad)}
 const exponential:any=fixture.numbers.find((x:any)=>x.stringText==='1e+21');assert.ok(exponential);assert.notEqual(exponential.stringText,'1e21');assert.notEqual(exponential.stringText,'1000000000000000000000');
 const c=fixture.numbers.find((x:any)=>x.inputBits==='3ff0000000000000');assert.notDeepEqual(observeNumber('3ff0000000000001'),c);
 const e=fixture.callers.find((x:any)=>x.expected.throw?.codePresent).expected.throw;assert.notDeepEqual({...e,code:'wrong'},e);assert.notDeepEqual({...e,ownKeys:[...e.ownKeys].reverse()},e);assert.notDeepEqual({...e,message:e.message+'!'},e);
});
