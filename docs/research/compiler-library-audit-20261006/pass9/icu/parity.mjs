import * as v from '@canlang/values';
import {execFileSync} from 'node:child_process';
import {writeFileSync,readFileSync} from 'node:fs';
const dir='/private/tmp/canlang-pass9-icu';
const binary=dir+'/pinned/compiler/target/debug/can';
const patterns=[['number','{n,number}',{int:true,decimal:true}],['integer','{n,number,integer}',{int:true,decimal:false}],['cardinal','{n,plural,one {one} other {#}}',{int:true,decimal:true}],['ordinal','{n,selectordinal,one {#st} other {#th}}',{int:true,decimal:false}]];
function capture(f){try{return {ok:true,value:f()}}catch(e){return {ok:false,name:e.name,code:e.code??null,message:e.message}}}
const cases=[];
for(const [usage,pattern,expected] of patterns)for(const type of ['int','decimal']){
 const path=dir+'/'+usage+'-'+type+'.can';const source='app T\nGiven\n message probe(n:'+type+') = '+JSON.stringify(pattern)+'@{}\nWhen\nThen\n';writeFileSync(path,source);
 let stdout,exit;try{stdout=execFileSync(binary,['check','--format=json','--catalog='+dir+'/pinned/packages/values/dist/catalog.json',path],{encoding:'utf8',timeout:10000});exit=0;}catch(e){stdout=e.stdout;exit=e.status;}
 const compiler=JSON.parse(stdout);const args={n:{type,value:type==='int'?21n:v.parseDecimal('21.50')}};
 cases.push({usage,type,pattern,expectedOk:expected[type],compiler:{exit,raw:compiler},ownerValidation:capture(()=>v.validateMessagePattern(pattern,{n:type})),ownerDescriptor:capture(()=>v.makeMessageDescriptor(pattern,{},args)),ownerRender:capture(()=>v.renderMessage(pattern,args,'en'))});
}
console.log(JSON.stringify({host:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},ownerEntry:import.meta.resolve('@canlang/values'),cases},(_,value)=>typeof value==='bigint'?value.toString()+'n':value,2));
