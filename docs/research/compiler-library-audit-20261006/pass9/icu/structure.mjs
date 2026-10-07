import * as v from '@canlang/values';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const dir='/private/tmp/canlang-pass9-icu';
const vectors=[
 ['plain','Hi {n}',true],['number','{n,number}',true],['integer','{n,number,integer}',true],
 ...['short','medium','long','full'].map(s=>['date-'+s,'{d,date,'+s+'}',true]),['time-default','{d,time}',true],
 ['cardinal','{n,plural,one {#} other {#}}',true],['ordinal','{n,selectordinal,one {#st} other {#th}}',true],
 ['select','{s,select,active {yes} other {no}}',true],['select-hyphen','{s,select,active-case {yes} other {no}}',true],
 ['exact-big','{n,plural,=9007199254740993 {exact} other {other}}',true],['exact-decimal','{n,plural,=1.5 {exact} other {other}}',true],
 ['duplicate-same','{n,plural,one {a} one {b} other {c}}',false],['duplicate-normalized','{n,plural,=1 {a} =1.0 {b} other {c}}',false],
 ['missing-other','{n,plural,one {a}}',false],['unknown-category','{n,plural,bogus {a} other {c}}',false],
 ['offset','{n,plural,offset:1 other {#}}',false],['choice','{n,choice,0#a|1#b}',false],['skeleton','{n,number,::currency/USD}',false],['custom-number','{n,number,currency}',false],['custom-date','{d,date,yyyy}',false],
 ['rich-tag','<b>{n}</b>',false],['self-rich-tag','<b/>',false],['quoted-brace',"'{ghost}' {n}",true],['doubled-apostrophe',"It''s {n}",true],
 ['friendly-apostrophe-undeclared',"Don't {ghost}",false],['quoted-unclosed',"'{ghost}",false],
 ['pound-top','#',true],['quoted-pound',"'#'",true],['nested-nearest-pound','{n,plural,other {{s,select,active {#} other {#}}}}',true],
 ['exact-negative','{n,plural,=-1 {negative} other {other}}',false],['exact-leading-dot','{n,plural,=.5 {half} other {other}}',false],['exact-trailing-dot','{n,plural,=1. {one} other {other}}',false],
 ['undeclared','{ghost}',false],['branches-literal','{s,select,active {ghost} other {body}}',true],['nested-undeclared','{s,select,active {{ghost}} other {body}}',false],
 ['white-name','{ n }',true],['white-undeclared','{ ghost }',false],['numeric-name','{0}',false],['unmatched-close','}',false]
];
function nested(n,leaf='text'){return '{s,select,other {'.repeat(n)+leaf+'}}'.repeat(n)}
for(const n of [31,32,33,34,256])vectors.push(['depth-text-'+n,nested(n),n<=32]);
for(const n of [31,32,33])vectors.push(['depth-arg-'+n,nested(n,'{n}'),n+1<=32]);
function capture(f){try{return {ok:true,value:f()}}catch(e){return {ok:false,name:e.name,code:e.code??null,message:e.message}}}
const declared={n:'int',s:'text',d:'datetime'};
const cases=vectors.map(([id,pattern,expectedOk])=>{
 const source='app T\nGiven\n message probe(n:int,s:text,d:datetime) = '+JSON.stringify(pattern)+'@{}\nWhen\nThen\n';const file=dir+'/structure-'+id+'.can';writeFileSync(file,source);let stdout,exit;try{stdout=execFileSync(dir+'/pinned/compiler/target/debug/can',['check','--format=json','--catalog='+dir+'/pinned/packages/values/dist/catalog.json',file],{encoding:'utf8',timeout:10000});exit=0}catch(e){stdout=e.stdout;exit=e.status}
 return {id,pattern,expectedOk,compiler:{exit,raw:JSON.parse(stdout)},owner:capture(()=>v.validateMessagePattern(pattern,declared)),ownerStructure:capture(()=>v.parseMessageFormat(pattern))};
});
console.log(JSON.stringify({expectedBasis:'DESIGN9.1 and public owner grammar/depth; numeric-name expected false because named signature contains no 0; pound top uses owner literal semantics',cases},(_,v)=>typeof v==='bigint'?v.toString()+'n':v,2));
